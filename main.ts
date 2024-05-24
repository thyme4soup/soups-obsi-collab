import { App, Editor, FileView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from 'obsidian';
import { DiffMatchPatch, PatchOperation } from 'diff-match-patch-ts';
import { CollabFileCache, FileShadow } from 'file-cache';
import { ServerRequest, ServerResponse, SyncUtil } from 'sync-util';
// Remember to rename these classes and interfaces!

interface PluginSettings {
	brokerEndpoint: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	brokerEndpoint: 'https://my.endpoint.com/',
}

export default class MyPlugin extends Plugin {
	settings: PluginSettings;
	fileCache: CollabFileCache = new CollabFileCache();
	syncUtil: SyncUtil = new SyncUtil(this.fileCache, this.app);


	async onload() {
		await this.loadSettings();
		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Synced!');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

		this.registerInterval(window.setInterval(() => {
			this.app.workspace.getLeavesOfType("markdown").forEach(async (leaf) => {
				if (leaf.view instanceof FileView) {
					let file: TFile | null = leaf.view.file;
					if (file) {
						await this.syncLoop(file);
					}
				}
				
			});
		}, 2000));

		console.log('Hello!')
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async syncLoop(file: TFile) {
		if (this.fileCache.isTracked(file.path)) {
			let content = await file.vault.cachedRead(file);
			let shadow = this.fileCache.getCachedFile(file.path).content;
			let outgoing_patch = this.fileCache.getPatchBlock(file.path, content);

			// just use the whole file rn lol
			let checksum = shadow;
			// get response patch from server
			let response = await this.syncUtil.postPatch({
				patch: outgoing_patch,
				path: file.path,
				checksum: checksum,
				userId: null,
				secretKey: null
			});
			if (response.status == 200) {
				// success
				let incoming_patch: string = response.patch;
				let checksum: string = response.checksum;
				if (checksum != shadow) {
					// checksums don't match
					// abandon local changes and refresh content
					console.log("Checksums don't match for", file.path, "refreshing content to", response.checksum);
					this.fileCache.updateCachedFile(file.path, response.checksum);
					file.vault.modify(file, response.checksum);
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
			} else {
				throw new Error("Server error" + response.status);
			}
		} else {
			this.fileCache.createCachedFile(file.path, await file.vault.cachedRead(file));
		}
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class SettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Broker Endpoint')
			.setDesc('The endpoint for your broker service')
			.addText(text => text
				.setPlaceholder('Enter your broker endpoint')
				.setValue(this.plugin.settings.brokerEndpoint)
				.onChange(async (value) => {
					this.plugin.settings.brokerEndpoint = value;
					await this.plugin.saveSettings();
				}));
	}
}
