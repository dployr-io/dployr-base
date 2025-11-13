/**
 * Pagination metadata
 */
export interface PaginationMeta {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
}

/**
 * Paginated data wrapper
 */
export interface PaginatedData<T> {
    items: T[];
    pagination: PaginationMeta;
}

/**
 * Standard success response with data
 */
export interface ApiSuccessResponse<T = any> {
    success: true;
    data: T;
    message?: string;
}

/**
 * Standard error response
 */
export interface ApiErrorResponse {
    success: false;
    error: {
        message: string;
        code?: string;
        details?: Array<{
            field: string;
            message: string;
        }>;
        helpLink?: string;
    };
}

/**
 * Union type for all API responses
 */
export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Helper functions to create consistent responses
 */
export const createSuccessResponse = <T>(
    data: T,
    message?: string
): ApiSuccessResponse<T> => ({
    success: true,
    data,
    ...(message && { message }),
});

export const createErrorResponse = ({
    message,
    code,
    details,
    helpLink,
}: {
    message: string;
    code?: string;
    details?: Array<{ field: string; message: string }>;
    helpLink?: string;
}): ApiErrorResponse => ({
    success: false,
    error: {
        message,
        ...(code && { code }),
        ...(details && { details }),
        ...(helpLink && { helpLink }),
    },
});

/**
 * Helper function to create paginated response
 */
export const createPaginatedResponse = <T>(
    items: T[],
    page: number,
    pageSize: number,
    totalItems: number
): PaginatedData<T> => {
    const totalPages = Math.ceil(totalItems / pageSize);

    return {
        items,
        pagination: {
            page,
            pageSize,
            totalItems,
            totalPages,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1,
        },
    };
};

/**
 * Helper function to parse pagination query params
 */
export const parsePaginationParams = (
    pageParam?: string | null,
    pageSizeParam?: string | null,
    defaultPageSize: number = 20,
    maxPageSize: number = 100
): { page: number; pageSize: number; offset: number } => {
    const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
    let pageSize = parseInt(pageSizeParam || String(defaultPageSize), 10) || defaultPageSize;

    // Enforce max page size
    pageSize = Math.min(pageSize, maxPageSize);
    pageSize = Math.max(1, pageSize);

    const offset = (page - 1) * pageSize;

    return { page, pageSize, offset };
};
