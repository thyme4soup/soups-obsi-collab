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
    root: string | null,
    userId: string | null,
    secretKey: string | null
}

export class FileDeletedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FileDeletedError";
    }
}

const API_VERSION = "v1";

// This class contains helper commands for interacting with the remote server
export class SyncUtil {
    app: App;
    rootDirectories: {[root: string]: string} = {};
    userId: string | null = null;
    secretKey: string | null = null;
    endpoint: string | null = null;

    constructor(app: App, endpoint: string, userId: string | null = null) {
        this.app = app;
        this.userId = userId;
        // remove trailing slash
        if (endpoint.endsWith("/")) {
            this.endpoint = endpoint.slice(0, -1);
        } else {
            this.endpoint = endpoint;
        }
    }

    async postPatch(request: ServerRequest): Promise<ServerResponse> {
        if (!this.userId) {
            throw new Error("No user id yet!");
        }
        request.userId = this.userId;
        request.secretKey = request.secretKey || this.secretKey;
        // call the server with the patch
        let url = [this.endpoint, API_VERSION, "patch"].join("/");
        let response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(request)
        });
        let responseJSON = await response.json();
        // convert to ServerResponse
        if (responseJSON.status == 409) {
            if (responseJSON.content.contains("File is deleted")) {
                throw new FileDeletedError("File is deleted");
            }
        } else if (responseJSON.status != 200) {
            console.log(responseJSON);
        }
        let responseObj: ServerResponse = {
            status: responseJSON.status,
            patch: responseJSON.patch,
            checksum: responseJSON.checksum,
            content: responseJSON.content
        };

        return responseObj;
    }

    async registerFile(path: string, root: string, content: string): Promise<string> {
        let url = [this.endpoint, API_VERSION, "register"].join("/");
        let response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                path: path,
                userId: this.userId,
                secretKey: this.secretKey,
                root: root,
                content: content
            })
        });
        let responseJSON = await response.json();
        if (this.userId == null && responseJSON.userId) {
            this.userId = this.userId || responseJSON.userId;
        }

        if (responseJSON.status == 409) {
            if (responseJSON.content.contains("File is deleted")) {
                throw new FileDeletedError("File is deleted");
            }
        } else if (responseJSON.status != 200) {
            throw new Error("Failed to register file");
        }
        // return the shadow to track
        return responseJSON.content;
    }

    async deleteFile(path: string, root: string): Promise<void> {
        console.log("Posting delete request for", path, "in root", root);
        let url = [this.endpoint, API_VERSION, "delete"].join("/");
        let response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                path: path,
                userId: this.userId,
                secretKey: this.secretKey,
                root: root
            })
        });
        let responseJSON = await response.json()
        if (response.status != 200) {
            throw new Error("Failed to delete file\n" + responseJSON.content);
        }
    }

    async getRoot(root: string) {
        let url = [this.endpoint, API_VERSION, "root"].join("/");
        let response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                root: root,
                userId: this.userId,
                secretKey: this.secretKey
            })
        });
        let responseJSON = await response.json()
        if (response.status != 200) {
            throw new Error("Failed to get root");
        }
        this.rootDirectories[root] = responseJSON.tree;
        return responseJSON.tree;
    }

    async registerRoot(): Promise<string> {
        let url = [this.endpoint, API_VERSION, "root"].join("/");
        let response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                userId: this.userId,
                secretKey: this.secretKey
            })
        });
        let responseJSON = await response.json();
        if (responseJSON.status != 200) {
            throw new Error("Failed to register root");
        }
        let root = responseJSON.root;
        return root;
    }
}