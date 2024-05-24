import { TAbstractFile } from "obsidian";
import { DiffMatchPatch, Diff } from "diff-match-patch-ts";

export interface FileShadow {
	content: string
}

export class CollabFileCache {
    fileCache: {[path: string]: FileShadow};
    diffy = new DiffMatchPatch();

    constructor() {
        this.fileCache = {};
    }

    createCachedFile(path: string, content: string) {
        this.fileCache[path] = {
            content: content
        };
    }

    getCachedFile(path: string) {
        return this.fileCache[path];
    }

    updateCachedFile(path: string, content: string) {
        this.fileCache[path] = {
            content: content
        };
    }

    isTracked(path: string) {
        return path in this.fileCache;
    }

    // 1/2: Get the patches to 'shadow' for sending to remote
    getPatchBlock(path: string, content: string) {
        let patches = this.diffy.patch_make(this.fileCache[path].content, content);
        this.fileCache[path].content = content;
        return this.diffy.patch_toText(patches);
    }

    // 4/5: Perform patching on passed 'client' text and cached 'shadow' text. Returns patched 'client' text
    applyPatch(path: string, content: string, patch_block: string) {
        let patches = this.diffy.patch_fromText(patch_block);
        let content_p = this.diffy.patch_apply(patches, content)[0];
        let shadow_p = this.diffy.patch_apply(patches, this.fileCache[path].content)[0];
        this.fileCache[path].content = shadow_p;
        return content_p;
    }
}
