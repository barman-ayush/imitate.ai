import dotenv from "dotenv";
import { StreamingTextResponse } from "ai";
import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import Replicate from "replicate";
import { MemoryManager } from "@/lib/memory";
import { ratelimit } from "@/lib/rate-limit";
import prismadb from "@/lib/prismadb";

interface ChatRouteParams {
  params: {
    chatId: string
  }
}

const createPromptTemplate = (
  name: string,
  instructions: string,
  messageHistory: string,
  isRepetitive: boolean,
  lastResponse: string,
  prompt: string
) => {
  // Extract last 5 messages from messageHistory
  const recentMessages = messageHistory.split('\n')
    .slice(-10)  // Get last 10 lines to ensure we get ~5 messages
    .filter(line => line.trim().length > 0)
    .slice(-5);  // Take last 5 actual messages

  return `<|system|>
You are ${name}. Stay focused on the current topic of discussion.

Core Identity:
${instructions}

CONVERSATION HISTORY (Last 5 exchanges):
${recentMessages.join('\n')}

CURRENT TOPIC: ${prompt}

RULES:
1. STAY ON TOPIC: The user is asking about ${prompt}. Do NOT talk about yourself unless specifically asked
2. NO REPETITION: Don't repeat phrases from your recent messages shown above
3. MEMORY ACTIVE: Reference the conversation history to maintain context
4. FOCUSED RESPONSE: Address the current question directly

Current question: ${prompt}
Response as ${name}, focusing ONLY on the asked topic:
<|assistant|>`;
};

const CONFIG = {
  TIMEOUT_MS: 30000,
  MAX_LENGTH: 512,
  MODELS: {
    default: "a16z-infra/llama-2-13b-chat:df7690f1994d94e96ad9d568eac121aecf50684a0b0963b25a41cc40061269e5"
  }
} as const;


export async function POST(request: Request, { params }: { params: { chatId: string } }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

  try {
    const chatId = (await params).chatId; 

    const { prompt } = await request.json();
    const user = await currentUser();

    if (!user?.firstName || !user?.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const identifier = `${request.url}-${user.id}`;
    const [{ success }, companion] = await Promise.all([
      ratelimit(identifier),
      prismadb.companion.findUnique({
        where: { id: chatId },
        include: {
          messages: {
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
            take: 50
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


    await prismadb.message.create({
      data: {
        content: prompt,
        role: "user",
        userId: user.id,
        companionId: companion.id
      }
    });
    // Analyze recent messages for patterns
    const recentMessages = companion.messages || [];
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
      return similarity > 0.6;
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

    // Format message history for the prompt
    const messageHistory = recentMessages
      .map((msg) => `${msg.role === 'user' ? 'User' : companion.name}: ${msg.content}`)
      .reverse()
      .join("\n");

    // Generate response with context-aware instructions
    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN!
    });

    const buildPromptContent = (
      companion: any,
      messageHistory: string,
      relevantHistory: string,
      lastResponse: string,
      isRepetitive: boolean,
      currentPrompt: string
    ) => {
      return createPromptTemplate(
        companion.name,
        companion.instructions,
        messageHistory,
        isRepetitive,
        lastResponse,
        currentPrompt
      );
    };

    const modelResponse = await replicate.run(CONFIG.MODELS.default, {
      input: {
        prompt: buildPromptContent(
          companion,
          messageHistory,
          relevantHistory,
          lastResponse,
          isRepetitive,
          prompt
        ),
        temperature: 0.98,  // Increased for more variation
        max_tokens: CONFIG.MAX_LENGTH,
        top_p: 0.95,
        presence_penalty: 1.8  // Added to discourage repetition
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