// CustomRetriever.ts

import { BaseRetriever, BaseRetrieverInput } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableConfig } from '@langchain/core/runnables';
import { DocumentInterface } from '@langchain/core/documents';
import { invokeModelWithFallback } from './utils/modelUtility'; // Adjust the import path as needed
import { SystemMessage, HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, SystemMessagePromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { ContextAdapter } from './ContextAdapter';
import { VectorStore } from '@langchain/core/vectorstores';
import { cleanModelResponse, messageContentToString, hasThinkTags } from './utils/utils';




type ExtendedMetadata = Record<string, any> & {
  processed?: boolean;
  originalLength?: number;
  processedLength?: number;
};

export class CustomRetriever extends BaseRetriever {
  lc_namespace = ["custom", "retriever"];
  private originalRetriever: BaseRetriever;
  private topRelevantDocs: number;
  private postProcessor: (
    docs: Document<ExtendedMetadata>[],
    query: string,
    verbose: boolean
  ) => Promise<Document<ExtendedMetadata>[]>;
  public verbose: boolean;
  private chatModel: BaseChatModel;
  private summationModel: BaseChatModel;
  private utilityModel: BaseChatModel;
  private keywordCache: Map<string, number>;
  private keywordCacheExpiration: number; // in milliseconds
  // Add a timestamp for the last keyword extraction
  private lastKeywordExtractionTime: number | null = null;
  private adapter?: ContextAdapter;
  private progressKey?: string;
  private flowId?: string;  // Make this optional
  private vectorStore: VectorStore;
  private k: number;




  constructor(fields: BaseRetrieverInput & {
    k?: number;
    retriever: BaseRetriever;
    vectorStore: VectorStore;
    topRelevantDocs: number;
    postProcessor: (
      docs: Document<ExtendedMetadata>[],
      query: string,
      verbose: boolean
    ) => Promise<Document<ExtendedMetadata>[]>;
    verbose?: boolean;
    chatModel: BaseChatModel;
    summationModel: BaseChatModel;
    utilityModel: BaseChatModel;
    adapter?: ContextAdapter;
    progressKey?: string;
    flowId?: string;
  }) {
    super(fields);
    this.originalRetriever = fields.retriever;
    this.vectorStore = fields.vectorStore;
    // Validate vectorStore
    if (!fields.vectorStore) {
      throw new Error("vectorStore is required");
    }
    if (typeof fields.vectorStore.similaritySearch !== 'function') {
      throw new Error("vectorStore must implement similaritySearch method");
    }
    this.topRelevantDocs = fields.topRelevantDocs;
    this.postProcessor = fields.postProcessor;
    this.verbose = fields.verbose ?? false;
    this.chatModel = fields.chatModel;
    this.summationModel = fields.summationModel;
    this.utilityModel = fields.utilityModel;
    this.keywordCache = new Map();
    this.keywordCacheExpiration = 2 * 60 * 1000; // 2 minutes
    this.adapter = fields.adapter;
    this.progressKey = fields.progressKey;
    this.flowId = fields.flowId;
    this.k = fields.k ?? 10;
  }

  async invoke(input: string, options?: RunnableConfig): Promise<DocumentInterface<Record<string, any>>[]> {
    const processId = Date.now();
    const query = input;

    // Clean up expired cache entries
    this.cleanUpCache();

    if (this.verbose) {
      console.log(`[CustomRetriever] Starting ProcessID-${processId} for query: "${query}"`);
    }

    try {
      if (this.adapter && this.progressKey && this.flowId) {
        await this.adapter.updateProgress(this.flowId, this.progressKey, "🔍 Searching for relevant information...");
      }

      // Perform regular retrieval
      if (this.verbose) console.log(`[CustomRetriever] Performing initial retrieval...`);
      let keywordProcessed = false;

      let results = await this.originalRetriever.invoke(query, options);

      if (this.verbose) {
        console.log(`[CustomRetriever] Initially retrieved ${results.length} documents`);
      }

      // Check if results need to be combined (in case of multi-query results)
      if (this.isMultiQueryResult(results)) {
        if (this.adapter && this.progressKey && this.flowId) {
          await this.adapter.updateProgress(this.flowId, this.progressKey, "🧞 Detected multi-query results. Combining...");
        }
        if (this.verbose) console.log(`[CustomRetriever] Detected multi-query results. Combining...`);
        results = this.combineMultiQueryResults(results);
      }

      // Extract keywords and perform keyword-based retrieval if cache is empty
      if (results.length === 0 && !keywordProcessed && this.keywordCache.size === 0) {
        if (this.verbose) {
          console.log(`[CustomRetriever] ProcessID-${processId}: Original retriever returned no results, trying keyword processing`);
        }

        const keywords = await this.extractKeywords(query);
        if (keywords.length > 0) {
          keywordProcessed = true;
          const keywordResults = await this.performKeywordRetrieval(keywords, options);
          results = keywordResults;
        }
        if (this.verbose) {
          console.log(`[CustomRetriever] Extracted keywords:`, keywords);
        }

        if (keywords.length > 0) {
          if (this.verbose) console.log(`[CustomRetriever] Performing keyword-based retrieval...`);
          const keywordResults = await this.performKeywordRetrieval(keywords, options);

          if (this.verbose) {
            console.log(`[CustomRetriever] Retrieved ${keywordResults.length} documents from keyword search`);
          }

          // Process keyword results
          if (this.verbose) console.log(`[CustomRetriever] Processing keyword results...`);
          const processedKeywordInfo = await this.processKeywordResults(keywordResults, query);

          // Append processed keyword info if it exists
          if (processedKeywordInfo) {
            results.push(processedKeywordInfo);
          }
        } else {
          if (this.verbose) console.log(`[CustomRetriever] No valid keywords extracted, skipping keyword search`);
        }
      } else {
        if (this.verbose) {
          console.log(`[CustomRetriever] Keyword cache is not empty. Using cached results.`);
        }
      }

      if (this.adapter && this.progressKey && this.flowId) {
        await this.adapter.updateProgress(this.flowId, this.progressKey, "📚 Processing retrieved information...");
      }

      // Apply post-processing to results
      if (this.verbose) console.log(`[CustomRetriever] Applying post-processing to results...`);
      results = await this.postProcessor(results, query, this.verbose);

      // Score and filter results
      if (this.verbose) console.log(`[CustomRetriever] Scoring ${results.length} documents`);
      const scoredResults = this.scoreResults(results);

      if (this.verbose) console.log(`[CustomRetriever] Filtering top ${this.topRelevantDocs} results`);
      const filteredResults = this.filterTopResults(scoredResults);

      if (this.verbose) {
        console.log(`[CustomRetriever] Final results prepared with total of ${filteredResults.length} documents`);
        filteredResults.forEach((doc, index) => {
          console.log(`[CustomRetriever] Document ${index + 1} score: ${doc.metadata.score}`);
        });
      }

      return filteredResults;
    }
    catch (error) {
      console.error(`[CustomRetriever] Error in invoke:`, error);
      throw error;
    }
  }

  public setRetrievalContext(flowId: string, adapter?: ContextAdapter, progressKey?: string) {
    this.flowId = flowId;
    this.adapter = adapter;
    this.progressKey = progressKey;
  }
  private isMultiQueryResult(results: any[]): results is Array<DocumentInterface<Record<string, any>>[]> {
    return results.length > 0 && Array.isArray(results[0]) &&
      results[0].length > 0 && 'pageContent' in results[0][0] && 'metadata' in results[0][0];
  }

  private combineMultiQueryResults(multiQueryResults: Document[][]): Document[] {
    if (this.verbose) console.log(`[CustomRetriever] Combining results from ${multiQueryResults.length} queries`);
    const combinedResults = multiQueryResults.flat();
    if (this.verbose) console.log(`[CustomRetriever] Combined ${combinedResults.length} total documents`);
    return this.deduplicateResults(combinedResults);
  }

  private deduplicateResults(results: Document[]): Document[] {
    if (this.verbose) console.log(`[CustomRetriever] Deduplicating ${results.length} documents`);
    const uniqueDocuments = new Map<string, Document>();

    for (const doc of results) {
      const key = `${doc.metadata.source || ''}-${doc.metadata.chunk_order || ''}`;
      if (!uniqueDocuments.has(key) || (doc.metadata.score || 0) > (uniqueDocuments.get(key)?.metadata.score || 0)) {
        uniqueDocuments.set(key, doc);
      }
    }

    const dedupedResults = Array.from(uniqueDocuments.values());
    if (this.verbose) console.log(`[CustomRetriever] After deduplication, ${dedupedResults.length} unique documents remain`);
    return dedupedResults;
  }

  private scoreResults(results: Document[]): Document[] {
    if (this.verbose) console.log(`[CustomRetriever] Scoring ${results.length} documents`);
    return results.map((doc, index) => {
      const score = doc.metadata.score ?? 1 - index / results.length;
      if (this.verbose) console.log(`[CustomRetriever] Document ${index + 1} assigned score: ${score}`);
      return {
        ...doc,
        metadata: {
          ...doc.metadata,
          score: score,
        },
      };
    });
  }

  private filterTopResults(results: Document[]): Document[] {
    if (this.verbose) console.log(`[CustomRetriever] Filtering top ${this.topRelevantDocs} results from ${results.length} documents`);
    const filteredResults = results
      .sort((a, b) => (b.metadata.score ?? 0) - (a.metadata.score ?? 0))
      .slice(0, this.topRelevantDocs);
    if (this.verbose) console.log(`[CustomRetriever] Filtered to ${filteredResults.length} top results`);
    return filteredResults;
  }

  private async extractKeywords(query: string): Promise<string[]> {
    try {
      const keywordPrompt = ChatPromptTemplate.fromMessages([
        SystemMessagePromptTemplate.fromTemplate(
          "Analyze the following input and determine if it's a valid query. If it is, extract and return 1-3 relevant keywords and no more else search will be aborted. Do not add additional comments or statements. If it's not a query or no relevant keywords can be extracted, respond with exactly 'NO_KEYWORD'."
        ),
        HumanMessagePromptTemplate.fromTemplate("Input: {query}\n\nResult:")
      ]);

      const formattedPrompt = await keywordPrompt.formatMessages({ query });

      if (this.verbose) {
        console.log(`[CustomRetriever] [Keyword Extraction] Prompt sent to LLM:`);
        console.log(formattedPrompt);
      }

      const keywordResponse: AIMessage = await invokeModelWithFallback(
        this.summationModel,
        this.chatModel,
        this.utilityModel,
        formattedPrompt,
        { initialTimeout: 30000, maxTimeout: 120000, retries: 2 }
      );

      if (this.verbose) {
        if (this.adapter && this.progressKey && this.flowId) {
          await this.adapter.updateProgress(this.flowId, this.progressKey, `🔍 Keyword Extraction LLM Response: ${keywordResponse}`);
        }
        console.log(`[CustomRetriever] [Keyword Extraction] LLM Response:`);
        console.log(keywordResponse.content);
      }

      if (typeof keywordResponse.content === "string") {
        let result = cleanModelResponse(keywordResponse.content.trim(), false).content;
        // Check if the extracted keyword is more than 4 words
        const wordCount = result.split(/\s+/).length;
        if (wordCount > 4) {
          if (this.verbose) {
            console.log(`[CustomRetriever] Keyword "${result}" contains ${wordCount} words. Reverting to NO_KEYWORD`);
          }
          result = "NO_KEYWORD";
        }

        // Add progress message showing the extracted keyword or no-keyword status
        if (this.adapter && this.progressKey && this.flowId) {
          const progressMessage = result !== "NO_KEYWORD"
            ? `🔍 Extracted keyword: "${result}". Searching...`
            : `🔍 No specific keyword found${wordCount > 5 ? ' (too many words)' : ''}. Performing general search...`;

          await this.adapter.updateProgress(this.flowId, this.progressKey, progressMessage);
        }

        return result !== "NO_KEYWORD" ? [result] : [];
      }
      return [];
    } catch (error) {
      console.error(`[CustomRetriever] Error extracting keywords: ${error}`);
      // Add error progress message
      if (this.adapter && this.progressKey && this.flowId) {
        await this.adapter.updateProgress(this.flowId, this.progressKey, "❌ Error extracting keywords. Proceeding with general search...");
      }
      return [];
    }
  }

  private async performKeywordRetrieval(
    keywords: string[],
    options?: RunnableConfig
  ): Promise<Document[]> {
    if (keywords.length === 0) {
      if (this.verbose) console.log(`[CustomRetriever] No keywords provided for retrieval.`);
      return [];
    }

    this.updateKeywordCache(keywords);
    const query = keywords.join(' ');

    if (this.verbose) {
      console.log(`[CustomRetriever] Performing semantic search for: "${query}"`);
    }

    const documents = await this.vectorStore.similaritySearch(query, this.k);

    if (this.verbose) {
      console.log(`[CustomRetriever] Retrieved ${documents.length} documents via semantic search`);
    }

    return documents;
  }

  private updateKeywordCache(keywords: string[]): void {
    const currentTime = Date.now();
    for (const keyword of keywords) {
      this.keywordCache.set(keyword, currentTime);
      if (this.verbose) {
        console.log(
          `[CustomRetriever] Updated cache for keyword "${keyword}" at ${new Date(currentTime).toISOString()}`
        );
      }
    }
  }

  private cleanUpCache(): void {
    const currentTime = Date.now();
    for (const [keyword, timestamp] of this.keywordCache.entries()) {
      if ((currentTime - timestamp) >= this.keywordCacheExpiration) {
        this.keywordCache.delete(keyword);
        if (this.verbose) {
          console.log(`[CustomRetriever] Cleaned up expired keyword "${keyword}" from cache.`);
        }
      }
    }
  }

  // Call this method at appropriate times, such as at the start of invoke()

  private generateFilter(keywords: string[]): any {
    if (this.verbose) {
      console.log(`[CustomRetriever] Generating filter for keywords: [${keywords.join(', ')}]`);
    }

    // Clean up the keywords
    const cleanedKeywords = keywords.map(keyword =>
      keyword.replace(/_/g, ' ').toLowerCase()
    );

    // Create a single "full phrase" match condition
    // plus individual match conditions for each keyword
    const shouldConditions = [
      {
        key: 'content',  // Ensure this matches the indexed field in Qdrant
        match: {
          text: cleanedKeywords.join(' ')
        }
      },
      ...cleanedKeywords.map(keyword => ({
        key: 'content',  // Ensure this matches the indexed field in Qdrant
        match: {
          text: keyword
        }
      }))
    ];

    // Construct the final filter object
    const filter = {
      should: shouldConditions,
      minimum_should_match: 1  // Qdrant uses "minimum_should_match" to specify the number of "should" clauses that must match
    };

    if (this.verbose) {
      console.log(`[CustomRetriever] Generated filter:`, JSON.stringify(filter, null, 2));
    }

    return filter;
  }


  private async processKeywordResults(
    keywordResults: Document[],
    originalQuery: string
  ): Promise<Document<ExtendedMetadata> | null> {
    if (keywordResults.length === 0) {
      if (this.verbose) console.log(`[CustomRetriever] No keyword results to process.`);
      return null;
    }

    try {
      if (this.verbose) console.log(`[CustomRetriever] Combining keyword result contents...`);
      const combinedContent = keywordResults
        .map((doc) => doc.pageContent)
        .join("\n\n");
      if (this.verbose) {
        console.log(`[CustomRetriever] Combined content length: ${combinedContent.length} characters`);
      }

      const relevancePrompt = ChatPromptTemplate.fromMessages([
        SystemMessagePromptTemplate.fromTemplate(
          `Given the original query: {query}
    
          Extract and summarize relevant information from the following text, focusing on information directly related to the query. 
          
          If no relevant information is found, respond with exactly "No relevant information."
          
          After the summary (or "No relevant information" response), on a new line, provide a not to strict relevance score between 0 and 1, where 0 means not relevant at all, and 1 means highly relevant.
          
          Text: {text}
          
          Relevant information:`
        ),
      ]);

      const formattedPrompt = await relevancePrompt.formatMessages({
        query: originalQuery,
        text: combinedContent,
      });

      if (this.verbose) {
        console.log(`[CustomRetriever] [Keyword Results Processing] Prompt sent to LLM:`);
        console.log(formattedPrompt);
      }

      const response: AIMessage = await invokeModelWithFallback(
        this.chatModel,
        this.summationModel,
        this.utilityModel,
        formattedPrompt,
        { initialTimeout: 30000, maxTimeout: 120000, retries: 3 }
      );

      if (this.verbose) {
        console.log(`[CustomRetriever] [Keyword Results Processing] LLM Response:`);
        console.log(response.content);
      }

      // Clean any think tags from the response
      const cleanedContent = cleanModelResponse(response.content, false).content;

      // Split the cleaned response into relevant info and score
      const responseLines = (typeof cleanedContent === "string" ? cleanedContent : "")
        .split('\n')
        .filter(line => line.trim() !== '');
      const relevantInfo = responseLines.slice(0, -1).join('\n').trim();
      const scoreString = responseLines[responseLines.length - 1];

      if (relevantInfo === "No relevant information." || !relevantInfo) {
        if (this.verbose) console.log(`[CustomRetriever] No relevant information found.`);
        return null;
      }

      // Extract the score from the last line
      const scoreMatch = scoreString.match(/Relevance score:\s*([\d.]+)/);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;

      if (this.verbose) {
        console.log(`[CustomRetriever] Extracted relevant information length: ${relevantInfo.length} characters`);
        console.log(`[CustomRetriever] Relevance score: ${score}`);
      }

      return new Document<ExtendedMetadata>({
        pageContent: relevantInfo,
        metadata: {
          source: "keyword_search",
          score: score,
        },
      });
    } catch (error) {
      console.error(`[CustomRetriever] Error processing keyword results: ${error}`);
      return null;
    }
  }
}

export class DummyRetriever extends BaseRetriever {
  lc_namespace = ["dummy", "retriever"];

  async invoke(input: string, options?: RunnableConfig): Promise<Document[]> {
    console.log(
      `[DummyRetriever] Query received: "${input}". No retrieval performed.`
    );
    return [];
  }
}
