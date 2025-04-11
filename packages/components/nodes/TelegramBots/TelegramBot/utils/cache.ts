//  utils/CacheKeys.ts
import crypto from 'crypto';

// Helper function to create a hash from a string
const createHash = (input: string): string => {
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16); // Use first 16 chars of SHA-256 hash
};

export const CacheKeys = {
  RelevantContext: (userId: string, question?: string) => {
    const baseKey = `relevantContext_${userId}`;
    return question ? `${baseKey}_q_${createHash(question)}` : baseKey;
  },
  ContextualizedQuery: (userId: string, question?: string) => {
    const baseKey = `contextualizedQuery_${userId}`;
    return question ? `${baseKey}_q_${createHash(question)}` : baseKey;
  },
  GameHistory: (userId: string) => `gameHistory_${userId}`,
  GameTopics: (userId: string) => `gameTopics_${userId}`,
  GameQuestions: (userId: string) => `gameQuestions_${userId}`,
  QuestionPatterns: (userId: string) => `questionPatterns${userId}`
};
