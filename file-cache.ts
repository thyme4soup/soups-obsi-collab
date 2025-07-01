import { DiffMatchPatch } from "diff-match-patch-typescript";
import * as crypto from 'crypto';

export interface FileShadow {
	content: string
}
export interface UpdateItem {
    // file path to update
    path: string,
    // epoch after which we can consume this update
    visibility: number
}
const md5 = (contents: string) => crypto.createHash('md5').update(contents).digest("hex");

let LOCK_TIMEOUT = 5000;


export class CollabFileCache {
    fileCache: {[path: string]: FileShadow} = {};
    updateLock: {[path: string]: number} = {};
    updateQueue: UpdateItem[] = [];
    diffy = new DiffMatchPatch();

    constructor() {
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

    // delay in ms
    pushUpdate(path: string, delay: number) {
        if (this.updateQueue.find((item) => item.path === path)) {
            return false;
        } else {
            this.updateQueue.push({
                path: path,
                visibility: Date.now() + delay
            });
            return true;
        }
    }

    getNextUpdate(depth: number = 0): string | null {
        let now = Date.now();
        let nextUpdate = this.updateQueue[0];
        if (depth >= this.updateQueue.length) {
            return null;
        } else if (nextUpdate && nextUpdate.visibility < now) {
            return this.updateQueue.splice(depth, 1).shift()!.path;
        } else {
            return this.getNextUpdate(depth + 1);
        }
    }

    acquireLock(path: string) {
        if (path in this.updateLock && Date.now() - this.updateLock[path] < LOCK_TIMEOUT) {
            return false;
        } else if (path in this.updateLock) {
            console.log("Overriding expired lock for " + path);
            delete this.updateLock[path];
        }
        this.updateLock[path] = Date.now();
        return true;
    }

    releaseLock(path: string) {
        delete this.updateLock[path];
    }

    revert(path: string, content: string) {
        if (this.fileCache[path]) {
            console.log("Reverting file to: " + content)
            this.fileCache[path].content = content;
        } else {
            console.warn("Can't revert a file that is not cached: " + path);
        }
    }

    // 1/2: Get the patches to 'shadow' for sending to remote
    getPatchBlock(path: string, content: string) {
        let patches = this.diffy.patch_make(this.fileCache[path].content, content, undefined);
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

    getChecksum(path: string) {
        let content = this.getCachedFile(path)?.content || "";
        return md5(content);
    }
}
