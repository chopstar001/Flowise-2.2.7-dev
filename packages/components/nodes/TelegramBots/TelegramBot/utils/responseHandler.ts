// utils/responseHandler.ts

import { IDManager, IdType } from './idManagement';

export interface NormalizedResponse {
    content: string;
    sessionInfo: {
      sessionId: string;
      userId: string;
      chatId: string;
    };
    metadata?: {
      status?: string;
      jobId?: string;
      error?: string;
      usageStats?: {
        queries: number;
        tokens: number;
      };
    };
  }
  
  export class ResponseHandler {
    static normalizeResponse(response: any): NormalizedResponse {
      const content = this.extractContent(response);
      const sessionInfo = this.normalizeSessionInfo(response);
      const metadata = this.extractMetadata(response);
  
      return {
        content,
        sessionInfo,
        metadata
      };
    }
  
    private static extractContent(response: any): string {
      if (response.result?.content) {
        try {
          const parsed = JSON.parse(response.result.content);
          return parsed.text || parsed.result || response.result.content;
        } catch {
          return response.result.content;
        }
      }
      return response.content || response.message || '';
    }
  
    private static normalizeSessionInfo(response: any): {
      sessionId: string;
      userId: string;
      chatId: string;
    } {
      return {
        sessionId: IDManager.formatId(response.result?.sessionId || response.sessionId, 'session'),
        userId: IDManager.formatId(response.result?.userId || response.userId, 'user'),
        chatId: IDManager.formatId(response.result?.chatId || response.chatId, 'chat')
      };
    }
  
    private static extractMetadata(response: any): Record<string, any> {
      return {
        status: response.status,
        jobId: response.jobId,
        error: response.error,
        usageStats: response.result?.usageStats
      };
    }
  }