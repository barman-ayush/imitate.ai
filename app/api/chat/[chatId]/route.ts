import dotenv from "dotenv";
import { StreamingTextResponse } from "ai";
import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import Replicate from "replicate";
import { MemoryManager } from "@/lib/memory";
import { ratelimit } from "@/lib/rate-limit";
import prismadb from "@/lib/prismadb";

// Cache for memory manager instances
let memoryManagerInstance: MemoryManager | null = null;

// Optimized similarity check with early termination
const calculateMessageSimilarity = (msg: any, prompt: string): boolean => {
  if (!msg.content) return false;

  // Quick length check before detailed analysis
  const msgLength = msg.content.length;
  const promptLength = prompt.length;
  if (Math.abs(msgLength - promptLength) / Math.max(msgLength, promptLength) > 0.5) {
    return false;
  }

  // Explicitly type the Sets as string sets
  const msgWords: Set<string> = new Set(
    msg.content.toLowerCase().split(/\s+/).filter((word: string) => Boolean(word))
  );
  const promptWords: Set<string> = new Set(
    prompt.toLowerCase().split(/\s+/).filter((word: string) => Boolean(word))
  );

  // Quick word count check
  if (Math.abs(msgWords.size - promptWords.size) / Math.max(msgWords.size, promptWords.size) > 0.5) {
    return false;
  }

  let commonWords = 0;
  // Convert Set to Array for iteration to avoid TypeScript error
  Array.from(msgWords).forEach(word => {
    if (promptWords.has(word)) commonWords++;
  });

  return commonWords / Math.max(msgWords.size, promptWords.size) > 0.6;
};

// Optimized prompt template with StringBuilder pattern
const createPromptTemplate = (
  name: string,
  instructions: string,
  messageHistory: string,
  isRepetitive: boolean,
  lastResponse: string,
  prompt: string
) => {
  const parts = [];
  parts.push(`<|system|>\nYou are ${name}. Stay focused on the current topic of discussion.\n\n`);
  parts.push(`Core Identity:\n${instructions}\n\n`);
  
  // Optimize message history processing
  const recentMessages = messageHistory.split('\n')
    .slice(-10)
    .filter(line => line.trim())
    .slice(-5);
  
  parts.push(`CONVERSATION HISTORY (Last 5 exchanges):\n${recentMessages.join('\n')}\n\n`);
  parts.push(`CURRENT TOPIC: ${prompt}\n\n`);
  parts.push(`RULES:\n1. STAY ON TOPIC: The user is asking about ${prompt}. Do NOT talk about yourself unless specifically asked\n`);
  parts.push(`2. NO REPETITION: Don't repeat phrases from your recent messages shown above\n`);
  parts.push(`3. MEMORY ACTIVE: Reference the conversation history to maintain context\n`);
  parts.push(`4. FOCUSED RESPONSE: Address the current question directly\n\n`);
  parts.push(`Current question: ${prompt}\nResponse as ${name}, focusing ONLY on the asked topic:\n<|assistant|>`);

  return parts.join('');
};

const CONFIG = {
  TIMEOUT_MS: 15000, // Reduced timeout
  MAX_LENGTH: 512,
  MODELS: {
    default: "a16z-infra/llama-2-13b-chat:df7690f1994d94e96ad9d568eac121aecf50684a0b0963b25a41cc40061269e5"
  }
} as const;

export async function POST(request: Request, { params }: { params: any }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

  try {
    // Parallel processing of initial requests
    const [
      chatId,
      { prompt },
      user
    ] = await Promise.all([
      (await params).chatId,
      request.json(),
      currentUser()
    ]);

    if (!user?.firstName || !user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const identifier = `${request.url}-${user.id}`;
    
    // Parallel processing of rate limit and companion fetch
    const [{ success }, companion] = await Promise.all([
      ratelimit(identifier),
      prismadb.companion.findUnique({
        where: { id: chatId },
        include: {
          messages: {
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
            take: 10 // Reduced from 50 to 10 for better performance
          }
        }
      })
    ]);

    if (!success) {
      return new NextResponse("Rate limit exceeded", { status: 429 });
    }

    if (!companion) {
      return new NextResponse("Companion not found", { status: 404 });
    }

    // Optimized message creation and similarity check
    const [recentMessages, messageCreation] = await Promise.all([
      companion.messages || [],
      prismadb.message.create({
        data: {
          content: prompt,
          role: "user",
          userId: user.id,
          companionId: companion.id
        }
      })
    ]);

    // Optimized similarity check
    const similarMessages = recentMessages.filter(msg => 
      calculateMessageSimilarity(msg, prompt)
    );

    const isRepetitive = similarMessages.length > 0;
    const lastResponse = similarMessages[0]?.content || "";

    // Optimize memory management
    const companionKey = {
      companionName: companion.id,
      userId: user.id,
      modelName: "meta/meta-llama-3-8b-instruct"
    };

    // Cache memory manager instance
    if (!memoryManagerInstance) {
      memoryManagerInstance = await MemoryManager.getInstance();
    }

    const [records, similarDocs] = await Promise.all([
      memoryManagerInstance.readLatestHistory(companionKey),
      memoryManagerInstance.vectorSearch(
        await memoryManagerInstance.readLatestHistory(companionKey),
        `${companion.id}.txt`
      )
    ]);

    if (records.length === 0) {
      await memoryManagerInstance.seedChatHistory(companion.seed, "\n\n", companionKey);
    }

    // Batch memory operations
    await Promise.all([
      memoryManagerInstance.writeToHistory(`User: ${prompt}\n`, companionKey),
      // Pre-initialize Replicate client
      new Replicate({ auth: process.env.REPLICATE_API_TOKEN! })
    ]);

    const messageHistory = recentMessages
      .map(msg => `${msg.role === 'user' ? 'User' : companion.name}: ${msg.content}`)
      .reverse()
      .join("\n");

    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN!
    });

    // Optimized model response
    const modelResponse = await replicate.run(CONFIG.MODELS.default, {
      input: {
        prompt: createPromptTemplate(
          companion.name,
          companion.instructions,
          messageHistory,
          isRepetitive,
          lastResponse,
          prompt
        ),
        temperature: 0.5, // Reduced for faster response
        max_tokens: CONFIG.MAX_LENGTH,
        top_p: 0.8,
        presence_penalty: 1.5
      }
    });

    const finalResponse = String(modelResponse).split("\n")[0].replaceAll(",", "");

    if (finalResponse?.length > 1) {
      // Batch final operations
      await Promise.all([
        memoryManagerInstance.writeToHistory(finalResponse.trim(), companionKey),
        prismadb.companion.update({
          where: { id: chatId },
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