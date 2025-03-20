//  utils/CacheKeys.ts
export const CacheKeys = {
  RelevantContext: (userId: string) => `relevantContext_${userId}`,
  ContextualizedQuery: (userId: string) => `contextualizedQuery_${userId}`,
  GameHistory: (userId: string) => `gameHistory_${userId}`,
  GameTopics: (userId: string) => `gameTopics_${userId}`,
  GameQuestions: (userId: string) => `gameQuestions_${userId}`,
  QuestionPatterns: (userId: string) => `questionPatterns${userId}`
};
