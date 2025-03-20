// utils/types/ThinkingTypes.ts
export enum ThinkingDisplayMode {
    SEPARATE_MESSAGE = 'separate',
    INLINE = 'inline',
    HIDDEN = 'hidden',
    DEBUG_ONLY = 'debug',
    INTERACTIVE = 'interactive'
}

export interface ThinkingPreferences {
    showThinking: boolean;
    thinkingDuration: number;
    displayMode: ThinkingDisplayMode;
    format: 'detailed' | 'summary' | 'none';
    autoDelete: boolean;
}

export interface ThinkingMetadata {
    timestamp: string;
    category?: string;
    confidence?: number;
    source?: string;
}

export interface ThinkingBlock {
    content: string;
    metadata?: ThinkingMetadata;
}

// Add type for cache key
export type ThinkingCacheKey = string | number;