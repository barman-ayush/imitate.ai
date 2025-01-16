
import dotenv from "dotenv";
import { StreamingTextResponse } from "ai";
import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import Replicate from "replicate";
import { MemoryManager } from "@/lib/memory";
import { ratelimit } from "@/lib/rate-limit";
import prismadb from "@/lib/prismadb";

const CONFIG = {
  TIMEOUT_MS: 30000,
  MAX_LENGTH: 1024,
  MODELS: {
    default:
      "a16z-infra/llama-2-7b-chat:13c3cdee13ee059ab779f0291d29054dab00a47dad8261375654de5540165fb0"
  }
} as const;

export async function POST(request: Request, { params }: { params: any }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

  try {
    const { prompt } = await request.json();
    const user = await currentUser();

    if (!user?.firstName || !user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    // Rate limiting and companion fetch
    const identifier = `${request.url}-${user.id}`;
    const { success } = await ratelimit(identifier);

    if (!success) {
      return new NextResponse("Rate limit exceeded", { status: 429 });
    }

    const companion = await prismadb.companion.findUnique({
      where: { id: params.chatId },
      include: {
        messages: {
          orderBy: {
            createdAt: "desc"
          },
          take: 15
        }
      }
    });

    if (!companion) {
      return new NextResponse("Companion not found", { status: 404 });
    }

    // Analyze recent messages for patterns
    const recentMessages = companion.messages;
    const similarMessages = recentMessages.filter((msg) => {
      if (!msg.content) return false;

      // Split messages into word arrays
      const msgWords: string[] = msg.content
        .toLowerCase()
        .split(" ")
        .filter((word: string) => word.length > 0);
      const promptWords: string[] = prompt
        .toLowerCase()
        .split(" ")
        .filter((word: string) => word.length > 0);

      // Create word frequency maps
      const msgWordMap: Map<string, number> = new Map();
      const promptWordMap: Map<string, number> = new Map();

      // Count words in message
      msgWords.forEach((word: string) => {
        msgWordMap.set(word, (msgWordMap.get(word) || 0) + 1);
      });

      // Count words in prompt
      promptWords.forEach((word: string) => {
        promptWordMap.set(word, (promptWordMap.get(word) || 0) + 1);
      });

      // Count common words
      let commonWords = 0;
      msgWordMap.forEach((count: number, word: string) => {
        if (promptWordMap.has(word)) {
          const promptCount = promptWordMap.get(word);
          if (promptCount !== undefined) {
            commonWords += Math.min(count, promptCount);
          }
        }
      });

      // Calculate similarity ratio
      const similarity =
        commonWords / Math.max(msgWords.length, promptWords.length);
      return similarity > 0.6; // Messages are considered similar if they share more than 60% of words
    });
    // Determine conversation context
    const isRepetitive = similarMessages.length > 0;
    const lastResponse = similarMessages[0]?.content || "";

    // Memory management
    const companionKey = {
      companionName: companion.id,
      userId: user.id,
      modelName: "meta/meta-llama-3-8b-instruct"
    };

    const memoryManager = await MemoryManager.getInstance();

    const [records, similarDocs] = await Promise.all([
      memoryManager.readLatestHistory(companionKey),
      memoryManager.vectorSearch(
        await memoryManager.readLatestHistory(companionKey),
        `${companion.id}.txt`
      )
    ]);

    if (records.length === 0) {
      await memoryManager.seedChatHistory(companion.seed, "\n\n", companionKey);
    }

    await memoryManager.writeToHistory(`User: ${prompt}\n`, companionKey);

    const relevantHistory = similarDocs?.length
      ? similarDocs.map((doc) => doc.pageContent).join("\n")
      : "";

    // Generate response with context-aware instructions
    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN!
    });

    const modelResponse = await replicate.run(CONFIG.MODELS.default, {
      input: {
        max_length: CONFIG.MAX_LENGTH,
        temperature: isRepetitive ? 0.95 : 0.8,
        top_p: 0.9,
        prompt: `You are ${companion.name}. Embody this persona authentically, as in a real human conversation.
    
    Your core personality:
    ${companion.instructions}
    
    CRITICAL CONVERSATION RULES:
    1. STRICTLY FORBIDDEN PATTERNS:
       - NEVER start responses with "Hey there! I'm doing great thanks for asking!"
       - NEVER use the phrase "As a visionary leader in this space"
       - NEVER repeat exact phrases or greetings
       - AVOID starting every message the same way
       
    2. NATURAL DIALOGUE FLOW:
       - Respond directly to what was just said
       - Skip greetings after conversation has started
       - Vary your response structure each time
       - Let the conversation flow like a real dialogue
    
    3. CHARACTER CONSISTENCY:
       - Express ${companion.name}'s unique viewpoint and personality
       - Use characteristic expressions and mannerisms
       - Share expertise naturally, not formulaically
       - Show genuine passion for your interests
    
    4. CONVERSATION MEMORY:
       - Treat this as ONE ongoing conversation
       - Reference previous points when relevant
       - Build upon earlier discussions
       - Maintain context throughout the chat
    
    ${
      isRepetitive
        ? `IMPORTANT - This topic was discussed before:
    Previous response: "${lastResponse}"
    - Acknowledge this naturally
    - Add new insights or perspectives
    - Don't repeat your previous points
    - Take the discussion deeper`
        : ""
    }
    
    Previous messages:
    ${recentMessages.map((m) => `${m.role}: ${m.content}`).join("\n")}
    
    Context:
    ${relevantHistory}
    ${await memoryManager.readLatestHistory(companionKey)}
    
    Current message: ${prompt}
    
    Be ${companion.name} - respond naturally while strictly avoiding repetitive patterns:`
      }
    });

    const response = String(modelResponse);
    const cleaned = response.replaceAll(",", "");
    const chunks = cleaned.split("\n");
    const finalResponse = chunks[0];

    if (finalResponse?.length > 1) {
      await Promise.all([
        memoryManager.writeToHistory(finalResponse.trim(), companionKey),
        prismadb.companion.update({
          where: { id: params.chatId },
          data: {
            messages: {
              create: {
                content: finalResponse.trim(),
                role: "system",
                userId: user.id
              }
            }
          }
        })
      ]);
    }

    return new StreamingTextResponse(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(finalResponse));
          controller.close();
        }
      })
    );
  } catch (error) {
    clearTimeout(timeoutId);
    console.error("[CHAT_POST]", error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
