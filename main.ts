import { App, DataWriteOptions, Editor, FileView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TextComponent } from 'obsidian';
import { CollabFileCache, FileShadow } from 'file-cache';
import { FileDeletedError, ServerRequest, ServerResponse, SyncUtil } from 'sync-util';
import { get } from 'http';
// Remember to rename these classes and interfaces!

interface PluginSettings {
	brokerEndpoint: string;
	sharedFolders: {[path:string]: string};
}

const DEFAULT_SETTINGS: PluginSettings = {
	brokerEndpoint: 'http://localhost:5000',
	sharedFolders: {}
}
const SHARED_FOLDER_ROOT = "Shared"

const SYNC_CALL_FREQUENCY_MS = 1000;
const OPEN_IDLE_SYNC_FREQUENCY_MS = 3000;
const FILE_REFRESH_FREQUENCY_MS = 30000;
const ROOT_REFRESH_FREQUENCY_MS = 60000;

export default class MyPlugin extends Plugin {
	settings: PluginSettings;
	syncUtil: SyncUtil;
	fileCache: CollabFileCache = new CollabFileCache();

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));

		this.registerEvent(this.app.vault.on("modify", (file: TFile) => {
			// on file modify, sync the file
			if (this.fileCache.acquireLock(file.path)) {
				this.trySync(file);
				this.fileCache.releaseLock(file.path);
			}
		}));
		this.registerEvent(this.app.workspace.on("file-open", (file: TFile) => {
			// on file modify, sync the file
			if (file != null && this.fileCache.acquireLock(file.path)) {
				this.trySync(file);
				this.fileCache.releaseLock(file.path);
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file: TFile) => {
			// on file delete, remove from cache
			if (this.fileCache.isTracked(file.path)) {
				this.deleteFile(file, this.getSharedRoot(file));
			} else {
				console.log("File not tracked", file.path);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", async (file: TFile, oldPath: string) => {
			// on file rename, delete old file and register new file
			if (this.fileCache.isTracked(oldPath)) {
				await this.deleteFileByPath(oldPath, this.getSharedRoot(file));
				if (this.fileCache.acquireLock(file.path)) {
					this.trySync(file);
					this.fileCache.releaseLock(file.path);
				}
			}
		}));
		this.registerInterval(window.setInterval(async () => {
			// every Xs, sync all open files
			await this.app.workspace.getLeavesOfType("markdown").forEach(async (leaf) => {
				if (leaf.view instanceof FileView) {
					let file: TFile | null = leaf.view.file;
					if (file && this.fileCache.isTracked(file.path) && this.fileCache.acquireLock(file.path)) {
						await this.trySync(file);
						this.fileCache.releaseLock(file.path);
					}
				}
			});
		}, OPEN_IDLE_SYNC_FREQUENCY_MS * (1 + Math.random() * 0.1)));
		this.registerInterval(window.setInterval(() => {
			// every Xs, enqueue files to be refreshed
			let sharedFolders = Object.keys(this.settings.sharedFolders);
			for (let folder of sharedFolders) {
				let files = this.app.vault.getFiles().filter((file) => {
					return file.path.startsWith(folder)
				});
				for (let file of files) {
					this.fileCache.pushUpdate(file.path, 0);
				}
			}
		}, FILE_REFRESH_FREQUENCY_MS * (1 + Math.random() * 0.1)));
		this.registerInterval(window.setInterval(async () => {
			// refresh files in the background, respecting a regular calling cadence
			let path = this.fileCache.getNextUpdate();
			if (path && this.fileCache.acquireLock(path)) {
				let file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					await this.trySync(file);
				}
				this.fileCache.releaseLock(path);
			} else if (path) {
				console.log("Failed to acquire lock for", path);
				this.fileCache.pushUpdate(path, 0);
			} else {
				// console.log("No updates to process");
			}
		}, SYNC_CALL_FREQUENCY_MS * (1 + Math.random() * 0.1)));
		this.registerInterval(window.setInterval(async () => {
			// every Xs, sync all shared folders
			let sharedFolders = Object.keys(this.settings.sharedFolders);
			for (let root of sharedFolders) {
				try {
					await this.syncRoot(root);
				} catch (e) {
					console.log("Failed to sync root", root, e);
				}
			}
		}, ROOT_REFRESH_FREQUENCY_MS * (1 + Math.random() * 0.1)));

		console.log('Hello!')
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.syncUtil = new SyncUtil(this.app, this.settings.brokerEndpoint)
		let sharedFolders = Object.keys(this.settings.sharedFolders);
		for (let folder of sharedFolders) {
			let files = this.app.vault.getFiles().filter((file) => {
				file.path.startsWith(folder)
			});
			for (let file of files) {
				await this.registerFile(file, this.settings.sharedFolders[folder]);
			}
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getRootPath(root: string) {
		return SHARED_FOLDER_ROOT + "/" + root;
	}

	getLocalizedPath(file: TFile) {
		let root = Object.keys(this.settings.sharedFolders).find((folder) => file.path.startsWith(this.getRootPath(folder)))!;
		return this.getLocalizedPathFromRootPath(root, file.path);
	}

	getLocalizedPathFromRootPath(root: string, path: string) {
		let root_path = this.getRootPath(root);
		if (!path) {
			throw new Error("No path provided");
		}
		let path_local = path.slice(root_path.length);
		// remove leading slash
		if (path_local.startsWith("/")) {
			path_local = path_local.slice(1);
		}
		return path_local;
	}

	// handles when root isn't the shared uuid (old behavior)
	getSharedRoot(file: TFile) {
		for (let folder of Object.keys(this.settings.sharedFolders)) {
			if (file.path.startsWith(this.getRootPath(folder))) {
				return this.settings.sharedFolders[folder];
			}
		}
		throw new Error("File not in shared folder: " + file.path);
	}

	async syncRoot(root: string) {
		// check if the root exists
		if (!(root in this.settings.sharedFolders)) {
			throw new Error("Root does not exist");
		}
		// get the root directory
		let folder = this.getRootPath(root);
		let tree = await this.syncUtil.getRoot(root);
		// walk the tree and create missing files or delete extra files
		for (let localizedPath of tree) {
			let path = folder + "/" + localizedPath;
			let file_name = localizedPath.split("/").pop();
			if (file_name.startsWith("DELETED_")) {
				let real_file = file_name.slice(8);
				let real_path = folder + "/" + real_file;
				let real_file_obj = this.app.vault.getAbstractFileByPath(real_path);
				if (real_file_obj instanceof TFile) {
					await this.app.vault.delete(real_file_obj);
				}
			}
			else if (!this.app.vault.getAbstractFileByPath(path)) {
				// create each folder along the path
				let folders = path.split("/").slice(0, -1);
				let current_path = "";
				for (let current_folder of folders) {
					current_path += current_folder + "/";
					if (!this.app.vault.getFolderByPath(current_path.slice(0, -1))) { // remove trailing slash
						console.log("Creating folder", current_path);
						try {
							await this.app.vault.createFolder(current_path);
						} catch (e) {
							console.log("Failed to create folder", current_path, e);
						}
					}
				}
				// then create the file
				await this.app.vault.create(path, "");
			}
		}
	}

	async trySync(file: TFile) {
		if (file.name === "Untitled.md") {
			return;
		}
		try {
			await this.syncLoop(file);
		} catch (e) {
			if (e instanceof FileDeletedError) {
				// file was deleted, remove from cache
				delete this.fileCache.fileCache[file.path];
				console.log("File deleted", file.path);
				file.vault.delete(file);
			} else {
				console.log("Error syncing file", file.path, e);
				throw e;
			}
		}
	}

	async syncLoop(file: TFile) {
		if (this.fileCache.isTracked(file.path) && Object.keys(this.settings.sharedFolders).some((root) => file.path.startsWith(this.getRootPath(root)))) {
			let path = this.getLocalizedPath(file);
			let root = this.getSharedRoot(file);
			let content = await file.vault.cachedRead(file);
			let checksum = this.fileCache.getChecksum(file.path);
			let shadow = this.fileCache.getCachedFile(file.path).content;
			let outgoing_patch = this.fileCache.getPatchBlock(file.path, content);
			// get response patch from server
			let response = await this.syncUtil.postPatch({
				patch: outgoing_patch,
				path: path,
				checksum: checksum,
				root: root,
				userId: null,
				secretKey: null
			});
			if (response.status == 200) {
				// success
				let incoming_patch: string = response.patch;
				let incoming_checksum: string = response.checksum;
				if (incoming_checksum != checksum) {
					// checksums don't match
					// leave the file as is and get corrected next patch call
					return;
				}
				// refresh content and ingest patch
				content = await file.vault.read(file);
				let content_p = this.fileCache.applyPatch(file.path, content, incoming_patch);
				if (incoming_patch.length > 0) {
					await file.vault.modify(file, content_p);
				}
			} else if (response.status == 409) {
				// conflict
				let new_shadow: string = response.content;
				this.fileCache.updateCachedFile(file.path, new_shadow);
				console.log("Conflict detected for", file.path, "refreshing content to", new_shadow);
				file.vault.modify(file, new_shadow);
			} else if (response.status == 404) {
				if (response.content.contains("Root does not exist")) {
					new Notice("Root does not exist for folder. Removing it!" + file.path);
					// get the shared folder
					let root = this.getSharedRoot(file)!;
					delete this.settings.sharedFolders[root];
				} else {
					// file not found, remove from cache
					delete this.fileCache.fileCache[file.path];
				}
			} else {
				throw new Error("Server error" + response.status);
			}
		} else if (Object.keys(this.settings.sharedFolders).some((root) => file.path.startsWith(this.getRootPath(root)))) {
			console.log("Registering file", file.path);
			await this.registerFile(file, this.getSharedRoot(file));
		}
	}

	async registerFile(file: TFile, root: string) {
		if (file.name === "Untitled.md") {
			return;
		}
		try {
			let shadow = await this.syncUtil.registerFile(this.getLocalizedPath(file), root, await file.vault.read(file));
			this.fileCache.createCachedFile(file.path, shadow);
		} catch (e) {
			if (e instanceof FileDeletedError) {
				// file was deleted, remove from cache
				// ToDo: if file was recently created, ask if user wants to restore instead
				delete this.fileCache.fileCache[file.path];
				console.log("File deleted", file.path);
				file.vault.delete(file);
			} else {
				console.log("Error registering file", file.path, e);
			}
		}
	}

	async deleteFile(file: TFile, root: string) {
		await this.syncUtil.deleteFile(this.getLocalizedPath(file), root);
	}

	async deleteFileByPath(path: string, root: string) {
		await this.syncUtil.deleteFile(this.getLocalizedPathFromRootPath(root, path), root);
	}
}

class SettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	registerFolderField: TextComponent;
	registerRootField: TextComponent;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Broker Endpoint')
			.setDesc('The endpoint for your broker service. Restart plugin after changing!')
			.addText(text => text
				.setPlaceholder('Enter your broker endpoint')
				.setValue(this.plugin.settings.brokerEndpoint)
				.onChange(async (value) => {
					this.plugin.settings.brokerEndpoint = value;
					await this.plugin.saveSettings();
				}));
		
		containerEl.createEl('hr');
		containerEl.createEl('h2', { text: 'Shared Folder List' });
		containerEl.createEl('p');
		containerEl.createEl('p');
		containerEl.createEl('span').createEl('b', { text: 'Note: ' });
		containerEl.createSpan({
			text: 'Removing entries does not delete the shared folder! It will remove it from syncing.',
		});

		console.log(this.plugin.settings.sharedFolders);
		for (const sharedFolder of Object.keys(this.plugin.settings.sharedFolders)) {
			console.log("Adding setting for", sharedFolder);
			new Setting(containerEl)
			  .setName(sharedFolder)
			  .addText(text => {
				text.setValue(this.plugin.settings.sharedFolders[sharedFolder])
				text.disabled = true;
				text.onChange(async (value) => {
					this.plugin.settings.sharedFolders[sharedFolder] = value;
					await this.plugin.saveSettings();
				});
			  })
			  .addButton(btn => {
				btn.setIcon('cross');
				btn.setTooltip('Remove this shared folder');
				btn.onClick(async () => {
					if (btn.buttonEl.textContent === '')
						btn.setButtonText('Click once more to confirm removal');
					else {
						const { buttonEl } = btn;
						const { parentElement } = buttonEl;
						if (parentElement?.parentElement) {
							parentElement.parentElement.remove();
						}
						delete this.plugin.settings.sharedFolders[sharedFolder];
						await this.plugin.saveSettings();
					}
				});
			  });
		}

		new Setting(containerEl)
			.setName('Share a folder')
			.setDesc('Register a folder with your server to start sharing')
			.addText(text => {
				text.setPlaceholder('Enter your folder path')
					.setValue("")
				this.registerFolderField = text;
			})
			.addButton(button => button
				.setButtonText('Register')
				.onClick(async () => {
					let folder = this.registerFolderField.getValue();
					try {
						let root = await this.plugin.syncUtil.registerRoot();
						console.log("Registered folder", folder, "with root", root);
						this.plugin.settings.sharedFolders[folder] = root;
						this.plugin.saveSettings();
						// reload the tab
						this.display();
					} catch (e) {
						new Notice("Failed to register folder");
						console.log("Failed to register folder", e);
					}
					this.registerFolderField.setValue("");
				}));
		new Setting(containerEl)
			.setName('Join a folder')
			.setDesc('Join a shared folder')
			.addText(text => {
				text.setPlaceholder('Enter a folder code')
					.setValue("")
				this.registerRootField = text;
			})
			.addButton(button => button
				.setButtonText('Register')
				.onClick(async () => {
					let root = this.registerRootField.getValue();
					try {
						try {
							let tree = await this.plugin.syncUtil.getRoot(root);
							// just use the root as the folder
							await this.app.vault.createFolder(root);
						} catch (e) {
							
						}
						this.plugin.settings.sharedFolders[root] = root;
						console.log("Registered folder", root);
						this.plugin.saveSettings();
						// reload the tab
						this.display();
					} catch (e) {
						new Notice("Failed to register folder");
						if (e.message != "Folder already exists") {
							console.log("Folder already exists", e);
						} else if (e.message != "Root does not exist") {
							console.log("Root does not exist", e);
						} else {
							console.log("Uncaught error", e);
						}
					}
					this.registerRootField.setValue("");
				}));
	}
}
