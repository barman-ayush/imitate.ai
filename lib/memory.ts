import { Redis } from "@upstash/redis";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { Document } from "@langchain/core/documents";

export type CompanionKey = {
  companionName: string;
  modelName: string;
  userId: string;
};

export class MemoryManager {
  private static instance: MemoryManager;
  private history: Redis;
  private vectorDBClient: Pinecone;
  private vectorStoreCache: Map<string, any>; // Cache for vector stores
  private embeddings: GoogleGenerativeAIEmbeddings;

  public constructor() {
    this.history = Redis.fromEnv();
    this.vectorDBClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY!,
    });
    this.vectorStoreCache = new Map();
    this.embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GOOGLE_API_KEY!,
      modelName: "embedding-001"
    });
  }

  public async init() {
  }

  public async vectorSearch(
    recentChatHistory: string,
    companionFileName: string
  ): Promise<Document<Record<string, any>>[]> {
    const pineconeIndex = this.vectorDBClient.Index(
      process.env.PINECONE_INDEX! || "companion"
    );
  
    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GOOGLE_API_KEY!,
      modelName: "embedding-001"
    });
  
    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
      pineconeIndex,
      namespace: companionFileName,
    });
  
    // Helper function to truncate text to stay within byte limit
    const truncateText = (text: string, maxBytes: number = 9700): string => {
      const encoder = new TextEncoder();
      const encoded = encoder.encode(text);
      if (encoded.length <= maxBytes) return text;
      
      // Binary search for the largest substring that fits
      let start = 0;
      let end = text.length;
      while (start < end - 1) {
        const mid = Math.floor((start + end) / 2);
        if (encoder.encode(text.slice(0, mid)).length <= maxBytes) {
          start = mid;
        } else {
          end = mid;
        }
      }
      return text.slice(0, start);
    };
  
    // Truncate the chat history before search
    const truncatedHistory = truncateText(recentChatHistory);
  
    // Improved similarity search with more context and better threshold
    const similarDocs = await vectorStore
      .similaritySearch(truncatedHistory, 5, {
        minSimilarity: 0.7
      })
      .catch((err) => {
        console.error("Failed to Get Vector Search Results.", err);
        return [];
      });
  
    return similarDocs;
  }

  public static async getInstance(): Promise<MemoryManager> {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
      await MemoryManager.instance.init();
    }
    return MemoryManager.instance;
  }

  private generateRedisCompanionKey(companionKey: CompanionKey): string {
    return `${companionKey.companionName}-${companionKey.modelName}-${companionKey.userId}`;
  }

  public async writeToHistory(text: string, companionKey: CompanionKey) {
    if (!companionKey || typeof companionKey.userId == "undefined") {
      console.error("Companion Key Set Incorrectly!");
      return "";
    }

    const key = this.generateRedisCompanionKey(companionKey);
    const result = await this.history.zadd(key, {
      score: Date.now(),
      member: text
    });

    return result;
  }

  public async readLatestHistory(companionKey: CompanionKey): Promise<string> {
    if (!companionKey || typeof companionKey.userId == "undefined") {
      console.error("Companion Key Set Incorrectly!");
      return "";
    }

    const key = this.generateRedisCompanionKey(companionKey);
    let result = await this.history.zrange(key, 0, Date.now(), {
      byScore: true
    });

    result = result.slice(-100).reverse();
    const recentChats = result.reverse().join("\n");
    return recentChats;
  }

  public async seedChatHistory(
    seedContent: String,
    delimiter: string = "\n",
    companionKey: CompanionKey
  ) {
    const key = this.generateRedisCompanionKey(companionKey);

    if (await this.history.exists(key)) {
      console.log("User Already Has Chat History.");
      return;
    }

    const content = seedContent.split(delimiter);
    let counter = 0;

    for (const line of content) {
      await this.history.zadd(key, { score: counter, member: line });
      counter += 1;
    }
  }
}