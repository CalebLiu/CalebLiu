/**
 * Claude Computer Use — 自托管 (client-side) 示例 (TypeScript)
 *
 * 模型负责"看截图 + 决定操作"，你的程序负责在自己的环境（VM/容器/浏览器）里
 * 实际执行截图、点击、键盘等动作，并把结果（主要是截图）回传给模型。
 *
 * 依赖:
 *   npm install @anthropic-ai/sdk
 *   环境变量 ANTHROPIC_API_KEY
 *
 * 工具版本 / beta header（取自官方文档）:
 *   - computer_20251124 + "computer-use-2025-11-24"
 *     适用于 Opus 4.8 / 4.7 / 4.6、Sonnet 4.6、Opus 4.5
 *   - computer_20250124 + "computer-use-2025-01-24"
 *     适用于较旧的模型（Sonnet 4.5、Haiku 4.5 等）
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // 从 ANTHROPIC_API_KEY 读取

const BETA = "computer-use-2025-11-24";
const MODEL = "claude-opus-4-8";

// 你的虚拟显示分辨率。建议 1080p 左右，平衡精度与成本。
// 注意：Opus 4.7/4.8 坐标与图像像素 1:1，长边最大 2576px，无需缩放换算。
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

const tools = [
  {
    type: "computer_20251124",
    name: "computer",
    display_width_px: DISPLAY_WIDTH,
    display_height_px: DISPLAY_HEIGHT,
    display_number: 1,
    // 让模型在小字/小元素看不清时可以放大某个区域
    enable_zoom: true,
  },
  // 可选的配套工具——非必须，按需保留
  { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
  { type: "bash_20250124", name: "bash" },
] satisfies Anthropic.Beta.BetaToolUnion[];

/* ------------------------------------------------------------------ *
 * 1) 你的环境驱动（self-hosted 的核心：这里要接你真实的 VM/容器/浏览器）
 *    实现方式自选：xdotool / nut.js / Playwright / Selenium 等。
 *    下面是接口契约 + 占位实现，把它换成你的真实驱动即可。
 * ------------------------------------------------------------------ */
interface ComputerEnv {
  /** 返回当前屏幕的 PNG 截图（base64，不含 data: 前缀） */
  screenshot(): Promise<string>;
  leftClick(x: number, y: number, modifier?: string): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string): Promise<void>; // 例如 "ctrl+s"
  mouseMove(x: number, y: number): Promise<void>;
  scroll(x: number, y: number, dir: string, amount: number): Promise<void>;
  // 需要更多动作（double_click / right_click / drag / wait 等）时按需扩展
}

// TODO: 替换为你的真实实现
const env: ComputerEnv = {
  async screenshot() {
    throw new Error("接入你的截图实现，返回 base64 PNG");
  },
  async leftClick(x, y, modifier) {
    console.log("leftClick", x, y, modifier ?? "");
  },
  async type(text) {
    console.log("type", JSON.stringify(text));
  },
  async key(combo) {
    console.log("key", combo);
  },
  async mouseMove(x, y) {
    console.log("mouseMove", x, y);
  },
  async scroll(x, y, dir, amount) {
    console.log("scroll", x, y, dir, amount);
  },
};

/* ------------------------------------------------------------------ *
 * 2) 把模型请求的某个动作，在你的环境里真正执行。
 *    截图动作返回 image content block；其余动作通常返回简短文本（或截图）。
 * ------------------------------------------------------------------ */
type ToolResultContent = Anthropic.Beta.BetaToolResultBlockParam["content"];

async function runAction(input: Record<string, any>): Promise<ToolResultContent> {
  const action = input.action as string;

  switch (action) {
    case "screenshot": {
      const data = await env.screenshot();
      return imageResult(data);
    }
    case "left_click": {
      const [x, y] = input.coordinate as [number, number];
      await env.leftClick(x, y, input.text); // input.text 可携带修饰键，如 "shift"
      return imageResult(await env.screenshot()); // 操作后回传新截图，便于模型核对
    }
    case "type": {
      await env.type(input.text as string);
      return imageResult(await env.screenshot());
    }
    case "key": {
      await env.key(input.text as string);
      return imageResult(await env.screenshot());
    }
    case "mouse_move": {
      const [x, y] = input.coordinate as [number, number];
      await env.mouseMove(x, y);
      return "moved";
    }
    case "scroll": {
      const [x, y] = input.coordinate as [number, number];
      await env.scroll(x, y, input.scroll_direction, input.scroll_amount ?? 3);
      return imageResult(await env.screenshot());
    }
    // zoom 动作由模型在需要看清细节时发出；通常你只需把对应区域截图回传
    default:
      return `unhandled action: ${action}`;
  }
}

function imageResult(base64Png: string): ToolResultContent {
  return [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: base64Png },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 3) 处理一轮响应里所有 tool_use，收集 tool_result
 * ------------------------------------------------------------------ */
async function processToolCalls(
  response: Anthropic.Beta.BetaMessage,
): Promise<Anthropic.Beta.BetaToolResultBlockParam[]> {
  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  for (const block of response.content) {
    if (block.type === "tool_use") {
      try {
        const content = await runAction(block.input as Record<string, any>);
        results.push({ type: "tool_result", tool_use_id: block.id, content });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * 4) Agent loop：模型请求动作 → 你执行 → 回传结果，直到模型不再调用工具
 * ------------------------------------------------------------------ */
async function samplingLoop(
  task: string,
  maxIterations = 20,
): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: task },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools,
      messages,
      betas: [BETA],
      // computer use 推荐结合 effort（Opus 4.7 默认 high；4.6/Sonnet 4.6 默认 medium）
      output_config: { effort: "high" },
    });

    // 打印模型的文字说明，便于观察
    for (const block of response.content) {
      if (block.type === "text") console.log("[claude]", block.text);
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults = await processToolCalls(response);
    if (toolResults.length === 0) {
      // 没有工具调用 = 任务完成
      return messages;
    }
    messages.push({ role: "user", content: toolResults });
  }
  return messages;
}

// 用法
samplingLoop("打开浏览器，搜索今天的天气，并截图给我").catch(console.error);
