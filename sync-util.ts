import { App, TFile } from "obsidian"
import { CollabFileCache } from "file-cache"

export interface ServerResponse {
    status: number,
    patch: string,
    checksum: string,
    // only used when checksums didn't match
    content: string
}
export interface ServerRequest {
    path: string,
    checksum: string,
    patch: string,
    userId: string | null,
    secretKey: string | null
}

// This class contains helper commands for interacting with the remote server
export class SyncUtil {
    fileCache: CollabFileCache;
    app: App;
    userId: string = "test";
    secretKey: string = "test";
    endpoint: string = "http://localhost:5000";
    path1: string | undefined = undefined;
    path2: string | undefined = undefined;

    constructor(fileCache: CollabFileCache, app: App) {
        this.fileCache = fileCache;
        this.app = app;
    }

    async postPatch(request: ServerRequest): Promise<ServerResponse> {
        request.userId = request.userId || request.path || this.userId;
        request.secretKey = request.secretKey || this.secretKey;
        // call the server with the patch
        let url = this.endpoint + "/patch";
        let response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(request)
        });
        let responseJSON = await response.json();
        // convert to ServerResponse
        let responseObj: ServerResponse = {
            status: responseJSON.status,
            patch: responseJSON.patch,
            checksum: responseJSON.checksum,
            content: responseJSON.content
        };

        return responseObj;
    }
}