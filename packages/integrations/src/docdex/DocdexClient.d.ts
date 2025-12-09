export interface DocdexSegment {
    id: string;
    docId: string;
    index: number;
    content: string;
    heading?: string;
}
export interface DocdexDocument {
    id: string;
    docType: string;
    path?: string;
    title?: string;
    content?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    segments?: DocdexSegment[];
}
export interface RegisterDocumentInput {
    docType: string;
    path?: string;
    title?: string;
    content: string;
    metadata?: Record<string, unknown>;
}
export declare class DocdexClient {
    private options;
    constructor(options?: {
        workspaceRoot?: string;
        storePath?: string;
        baseUrl?: string;
        authToken?: string;
    });
    private getStorePath;
    private normalizePath;
    private loadStore;
    private fetchRemote;
    private saveStore;
    fetchDocumentById(id: string): Promise<DocdexDocument>;
    findDocumentByPath(docPath: string, docType?: string): Promise<DocdexDocument | undefined>;
    search(filter: {
        docType?: string;
        projectKey?: string;
        query?: string;
        profile?: string;
    }): Promise<DocdexDocument[]>;
    registerDocument(input: RegisterDocumentInput): Promise<DocdexDocument>;
    ensureRegisteredFromFile(docPath: string, docType: string, metadata?: Record<string, unknown>): Promise<DocdexDocument>;
}
//# sourceMappingURL=DocdexClient.d.ts.map