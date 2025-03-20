// MemoryManager.ts

import { FlowiseMemory, MessageType, IMessage } from '../../../src/Interface';
import { BaseMessage, HumanMessage, AIMessage, MessageContent } from '@langchain/core/messages';
import { IExtendedMemory, ExtendedIMessage } from './commands/types';
import { logInfo, logError } from './loggingUtility';

export class MemoryManager extends FlowiseMemory implements IExtendedMemory {
    private storage: Map<string, ExtendedIMessage[]> = new Map();
    constructor() {
        super();
    }

    getMemoryType(): string {
        return 'MemoryManager';
    }

    getStorageKey(userId: string, sessionId: string): string {
        return `user_${userId}_session_${sessionId}`;
    }

    /**
     * Get chat messages (FlowiseMemory compatibility method)
     * @param overrideSessionId - Combined userId:sessionId string (legacy format)
     * @param returnBaseMessages - Whether to return BaseMessage objects
     * @param prependMessages - Messages to prepend to the result
     * @returns Promise<BaseMessage[] | IMessage[]>
     * 
     * Note: This method is maintained for backward compatibility with FlowiseMemory.
     * It internally calls getChatMessagesExtended with split userId and sessionId.
     * For new code, prefer using getChatMessagesExtended directly.
     */
    async getChatMessages(
        overrideSessionId?: string,
        returnBaseMessages: boolean = false,
        prependMessages: IMessage[] = []
    ): Promise<BaseMessage[] | IMessage[]> {
        const [userId, sessionId] = (overrideSessionId || 'default:default').split(':');
        const extendedMessages = await this.getChatMessagesExtended(userId, sessionId, returnBaseMessages, this.convertToExtendedIMessages(prependMessages));

        if (returnBaseMessages) {
            return extendedMessages as BaseMessage[];
        } else {
            return this.convertToIMessages(extendedMessages as ExtendedIMessage[]);
        }
    }

    private convertToExtendedIMessages(messages: IMessage[]): ExtendedIMessage[] {
        return messages.map(msg => ({
            ...msg,
            message: msg.message,
            text: msg.message
        }));
    }

    private convertToIMessages(messages: ExtendedIMessage[]): IMessage[] {
        return messages.map(msg => ({
            type: msg.type,
            message: this.messageContentToString(msg.message || msg.text || '')
        }));
    }


    async addChatMessages(msgArray: { text: string; type: MessageType; }[], overrideSessionId?: string): Promise<void> {
        const [userId, sessionId] = (overrideSessionId || 'default:default').split(':');
        const extendedMsgArray: ExtendedIMessage[] = msgArray.map(msg => ({
            message: msg.text,
            text: msg.text,
            type: msg.type
        }));
        return this.addChatMessagesExtended(extendedMsgArray, userId, sessionId);
    }

    async addChatMessage(message: string, type: MessageType, overrideSessionId?: string): Promise<void> {
        await this.addChatMessages([{ text: message, type }], overrideSessionId);
    }

    async clearChatMessages(overrideSessionId?: string): Promise<void> {
        const [userId, sessionId] = (overrideSessionId || 'default:default').split(':');
        return this.clearChatMessagesExtended(userId, sessionId);
    }

    /**
     * Get chat messages with separate userId and sessionId
     * @param userId - User identifier
     * @param sessionId - Session identifier
     * @param returnBaseMessages - Whether to return BaseMessage objects
     * @param prependMessages - Messages to prepend to the result
     * @returns Promise<BaseMessage[] | IMessage[]>
     * 
     * Note: This is the preferred method for new code. It provides more granular
     * control over user and session management.
     */
    async getChatMessagesExtended(
        userId: string,
        sessionId: string,
        returnBaseMessages: boolean = false,
        prependMessages: ExtendedIMessage[] = []
    ): Promise<BaseMessage[] | ExtendedIMessage[]> {
        const key = this.getStorageKey(userId, sessionId);
        console.log(`[MemoryManager] Retrieving messages for key: ${key}`);
        console.log(`[MemoryManager] All keys in storage: ${Array.from(this.storage.keys())}`);

        const messages = this.storage.get(key) || [];
        console.log(`[MemoryManager] Retrieved ${messages.length} messages for key ${key}`);

        if (messages.length > 0) {
            console.log(`[MemoryManager] First message: ${JSON.stringify(messages[0])}`);
            console.log(`[MemoryManager] Last message: ${JSON.stringify(messages[messages.length - 1])}`);
        } else {
            console.log(`[MemoryManager] No messages found for key ${key}`);
        }

        if (returnBaseMessages) {
            const baseMessages: BaseMessage[] = [
                ...prependMessages.map(this.convertToBaseMessage),
                ...messages.map(this.convertToBaseMessage)
            ];
            return baseMessages;
        }
        return [...prependMessages, ...messages];
    }

    async addChatMessagesExtended(msgArray: ExtendedIMessage[], userId: string, sessionId: string): Promise<void> {
        const key = this.getStorageKey(userId, sessionId);
        console.log(`[MemoryManager] Adding messages for key: ${key}`);
    
        try {
            const existingMessages = this.storage.get(key) || [];
            const newMessages = msgArray.map(msg => ({
                message: msg.message,
                text: msg.text,
                type: msg.type,
                additional_kwargs: msg.additional_kwargs
            }));
    
            // Merge existing and new messages
            const updatedMessages = [...existingMessages, ...newMessages];
    
            // Update storage with merged messages
            this.storage.set(key, updatedMessages);
    
            console.log(`[MemoryManager] Updated memory for key ${key}. Total messages: ${updatedMessages.length}`);
            console.log(`[MemoryManager] Last added message: ${JSON.stringify(updatedMessages[updatedMessages.length - 1])}`);
        } catch (error) {
            console.error(`[MemoryManager] Error adding messages for key ${key}:`, error);
            // Don't throw the error, just log it
        }
    }


    async clearChatMessagesExtended(userId: string, sessionId: string): Promise<void> {
        const key = this.getStorageKey(userId, sessionId);
        this.storage.delete(key);
    }

    async clearAllChatMessages(): Promise<void> {
        const methodName = 'clearAllChatMessages';
        logInfo(methodName, 'Starting clear all chat messages operation');
    
        try {
            // Log current storage state
            const initialSize = this.storage.size;
            const keys = Array.from(this.storage.keys());
            
            logInfo(methodName, `Current storage state:`, {
                size: initialSize,
                keys: keys
            });
    
            // Clear storage
            this.storage.clear();
            
            // Verify storage is cleared
            const finalSize = this.storage.size;
            
            logInfo(methodName, `Storage cleared:`, {
                initialSize,
                finalSize,
                clearedKeys: keys.length
            });
    
            if (finalSize !== 0) {
                throw new Error('Storage not fully cleared');
            }
    
            logInfo(methodName, 'All chat messages cleared successfully');
        } catch (error) {
            logError(methodName, 'Failed to clear all chat messages', error as Error);
            throw error;
        }
    }

    async getChatHistoryString(overrideSessionId?: string): Promise<string> {
        const messages = await this.getChatMessages(overrideSessionId);
        return messages.map(msg => {
            if ('type' in msg && 'message' in msg) {
                return `${msg.type === 'userMessage' ? 'Human' : 'AI'}: ${msg.message}`;
            } else {
                return `${msg.getType() === 'human' ? 'Human' : 'AI'}: ${msg.content}`;
            }
        }).join('\n');
    }
    private convertToBaseMessage(msg: ExtendedIMessage): BaseMessage {
        const content = this.messageContentToString(msg.message || msg.text || '');
        if (msg.type === 'userMessage') {
            return new HumanMessage(content);
        } else {
            return new AIMessage(content);
        }
    }

    private messageContentToString(content: MessageContent): string {
        if (typeof content === 'string') {
            return content;
        } else if (Array.isArray(content)) {
            return content.map(item => {
                if (typeof item === 'string') {
                    return item;
                } else if (typeof item === 'object' && item !== null) {
                    return JSON.stringify(item);
                }
                return String(item);
            }).join(' ');
        }
        return JSON.stringify(content);
    }


    async saveContext(inputValues: any, outputValues: any): Promise<void> {
        const userId = inputValues.userId || 'default';
        const sessionId = inputValues.sessionId || 'default';
        const messages: ExtendedIMessage[] = [
            {
                message: inputValues.input,
                text: inputValues.input,
                type: 'userMessage' as MessageType
            },
            {
                message: outputValues.output,
                text: outputValues.output,
                type: 'apiMessage' as MessageType
            }
        ];
        await this.addChatMessagesExtended(messages, userId, sessionId);
    }

    async loadMemoryVariables(values: any): Promise<any> {
        const userId = values.userId || 'default';
        const sessionId = values.sessionId || 'default';
        const messages = await this.getChatMessagesExtended(userId, sessionId);
        return { history: messages };
    }

    // Debug method to dump all messages
    dumpAllMessages(): void {
        console.log('--- Dumping all stored messages ---');
        this.storage.forEach((messages, key) => {
            console.log(`Key: ${key}`);
            console.log(`Message count: ${messages.length}`);
            if (messages.length > 0) {
                console.log('First message:', messages[0]);
                console.log('Last message:', messages[messages.length - 1]);
            }
        });
        console.log('--- End of message dump ---');
    }
}