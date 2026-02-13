export declare const READY_TO_CODE_REVIEW = "ready_to_code_review";
export declare const CHANGES_REQUESTED = "changes_requested";
export declare const WORK_ALLOWED_STATUSES: string[];
export declare const REVIEW_ALLOWED_STATUSES: string[];
export declare const QA_ALLOWED_STATUSES: string[];
export declare const normalizeReviewStatuses: (statuses: string[]) => string[];
export declare const filterTaskStatuses: (input: string[] | undefined, allowed: string[], fallback: string[]) => {
    filtered: string[];
    rejected: string[];
};
export declare const isReadyToReviewStatus: (status?: string | null) => boolean;
//# sourceMappingURL=TaskStatus.d.ts.map