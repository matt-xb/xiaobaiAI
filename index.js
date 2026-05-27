const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { init: initDB, Counter } = require("./db");

const TEST_IMAGE2_API_KEY = "这里填我的测试key";
const IMAGE2_API_KEY = process.env.IMAGE2_API_KEY || TEST_IMAGE2_API_KEY;
const IMAGE2_BASE_URL = process.env.IMAGE2_BASE_URL || "https://3698520.xyz";
const IMAGE2_MODEL = process.env.IMAGE2_MODEL || "gpt-image-2";
const imageTasks = new Map();

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "20mb" }));
app.use(cors());
app.use(logger);

app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/count", async (req, res) => {
  const { action } = req.body;
  if (action === "inc") {
    await Counter.create();
  } else if (action === "clear") {
    await Counter.destroy({
      truncate: true,
    });
  }
  res.send({
    code: 0,
    data: await Counter.count(),
  });
});

app.get("/api/count", async (req, res) => {
  const result = await Counter.count();
  res.send({
    code: 0,
    data: result,
  });
});

function normalizeRatio(ratio) {
  return typeof ratio === "string" && ratio.trim() ? ratio.trim() : "1:1";
}

function normalizeStyle(style) {
  return typeof style === "string" && style.trim() ? style.trim() : "真实摄影";
}

function getImageSizeByRatio(ratio) {
  const sizeMap = {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1536x1024",
    "3:4": "1024x1536",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
  };

  return sizeMap[ratio] || "1024x1024";
}

function buildImagePrompt({ prompt, ratio, style }) {
  return [
    prompt,
    `风格：${style}`,
    `画面比例：${ratio}`,
    "请严格参考用户上传的图片主体、结构和外观，在此基础上进行改图生成。",
  ].join("\n");
}

function extractImageResult(data) {
  const firstImage = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!firstImage) {
    return null;
  }

  if (firstImage.url) {
    return {
      imageUrl: firstImage.url,
      responseType: "url",
    };
  }

  if (firstImage.b64_json) {
    return {
      imageUrl: `data:image/png;base64,${firstImage.b64_json}`,
      responseType: "b64_json",
    };
  }

  return null;
}

function getFileNameFromUrl(imageUrl, index) {
  try {
    const pathname = new URL(imageUrl).pathname;
    const name = pathname.split("/").filter(Boolean).pop();
    if (name && /\.[a-zA-Z0-9]+$/.test(name)) {
      return name;
    }
  } catch (error) {
    // Keep the fallback filename.
  }
  return `reference-${index + 1}.png`;
}

async function fetchReferenceImages(referenceImageUrls) {
  const files = [];

  for (let index = 0; index < referenceImageUrls.length; index += 1) {
    const imageUrl = referenceImageUrls[index];
    const response = await fetch(imageUrl);
    const responseTextForError = response.ok ? "" : await response.text();

    if (!response.ok) {
      console.error("参考图下载失败", {
        status: response.status,
        responseText: responseTextForError,
        imageUrl,
      });
      throw new Error("参考图下载失败");
    }

    const contentType = response.headers.get("content-type") || "image/png";
    const arrayBuffer = await response.arrayBuffer();
    files.push({
      blob: new Blob([arrayBuffer], { type: contentType }),
      fileName: getFileNameFromUrl(imageUrl, index),
    });
  }

  return files;
}

async function postImageEditForm({ endpoint, formData, imageCount }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMAGE2_API_KEY}`,
    },
    body: formData,
  });

  const responseText = await response.text();
  if (!response.ok) {
    console.error("image2 edits API request failed", {
      status: response.status,
      responseText,
      endpoint,
      model: IMAGE2_MODEL,
      imageCount,
    });
    throw new Error("image2 edits API request failed");
  }

  let responseData = {};
  if (responseText) {
    try {
      responseData = JSON.parse(responseText);
    } catch (error) {
      console.error("image2 edits API returned non-JSON response", {
        status: response.status,
        responseText,
        endpoint,
        model: IMAGE2_MODEL,
        imageCount,
      });
      throw new Error("image2 edits API returned non-JSON response");
    }
  }

  const imageResult = extractImageResult(responseData);
  if (!imageResult) {
    console.error("image2 edits API response did not include image data", {
      status: response.status,
      responseText,
      endpoint,
      model: IMAGE2_MODEL,
      imageCount,
    });
    throw new Error("image2 edits API response did not include image data");
  }

  return imageResult;
}

async function callImage2EditApi({ prompt, ratio, style, referenceImageUrls }) {
  if (!IMAGE2_API_KEY || IMAGE2_API_KEY === TEST_IMAGE2_API_KEY) {
    console.warn("IMAGE2_API_KEY 未配置，当前使用代码里的测试 key");
  }

  const endpoint = `${IMAGE2_BASE_URL.replace(/\/$/, "")}/v1/images/edits`;
  const size = getImageSizeByRatio(ratio);
  const finalPrompt = buildImagePrompt({ prompt, ratio, style });
  const imageFiles = await fetchReferenceImages(referenceImageUrls);

  async function sendWithImages(files) {
    const formData = new FormData();
    formData.append("model", IMAGE2_MODEL);
    formData.append("prompt", finalPrompt);
    formData.append("size", size);

    files.forEach((file) => {
      formData.append("image", file.blob, file.fileName);
    });

    console.log("Calling image2 edits API", {
      endpoint,
      model: IMAGE2_MODEL,
      imageCount: files.length,
      promptLength: finalPrompt.length,
      size,
    });

    return postImageEditForm({
      endpoint,
      formData,
      imageCount: files.length,
    });
  }

  if (imageFiles.length <= 1) {
    return sendWithImages(imageFiles);
  }

  try {
    return await sendWithImages(imageFiles);
  } catch (error) {
    console.error("多参考图 edits 调用失败，重试首张参考图", {
      endpoint,
      model: IMAGE2_MODEL,
      imageCount: imageFiles.length,
      promptLength: finalPrompt.length,
      size,
      error,
    });
    return sendWithImages(imageFiles.slice(0, 1));
  }
}

function validateImageRequest(body) {
  const {
    prompt,
    ratio: rawRatio = "1:1",
    style: rawStyle = "真实摄影",
    referenceFileIDs,
    referenceImageUrls,
  } = body || {};

  const normalizedPrompt = typeof prompt === "string" ? prompt.trim() : "";
  const ratio = normalizeRatio(rawRatio);
  const style = normalizeStyle(rawStyle);

  if (!normalizedPrompt) {
    return {
      valid: false,
      statusCode: 400,
      message: "prompt 不能为空",
    };
  }

  if (!Array.isArray(referenceFileIDs) || referenceFileIDs.length < 1) {
    return {
      valid: false,
      statusCode: 400,
      message: "referenceFileIDs 至少需要 1 张图片",
    };
  }

  if (!Array.isArray(referenceImageUrls) || referenceImageUrls.length < 1) {
    return {
      valid: false,
      statusCode: 400,
      message: "referenceImageUrls 至少需要 1 张图片链接",
    };
  }

  return {
    valid: true,
    prompt: normalizedPrompt,
    ratio,
    style,
    referenceFileIDs,
    referenceImageUrls,
  };
}

async function runImageTask(taskId) {
  const task = imageTasks.get(taskId);
  if (!task) {
    return;
  }

  try {
    const { imageUrl, responseType } = await callImage2EditApi({
      prompt: task.prompt,
      ratio: task.ratio,
      style: task.style,
      referenceImageUrls: task.referenceImageUrls,
    });

    imageTasks.set(taskId, {
      ...task,
      status: "completed",
      message: "生成完成",
      imageUrl,
      responseType,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("异步 image2 edits 任务失败", {
      taskId,
      error,
    });

    imageTasks.set(taskId, {
      ...task,
      status: "failed",
      message: "生成失败",
      updatedAt: new Date().toISOString(),
    });
  }
}

app.post("/api/create-image-task", async (req, res) => {
  const validation = validateImageRequest(req.body);
  if (!validation.valid) {
    return res.status(validation.statusCode).send({
      success: false,
      message: validation.message,
    });
  }

  const taskId = crypto.randomUUID();
  imageTasks.set(taskId, {
    taskId,
    status: "processing",
    message: "图片生成中",
    prompt: validation.prompt,
    ratio: validation.ratio,
    style: validation.style,
    referenceFileIDs: validation.referenceFileIDs,
    referenceImageUrls: validation.referenceImageUrls,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  setImmediate(() => {
    runImageTask(taskId);
  });

  return res.send({
    success: true,
    taskId,
    message: "任务已创建，正在生成",
  });
});

app.get("/api/image-task-status", async (req, res) => {
  const { taskId } = req.query;
  if (!taskId || typeof taskId !== "string") {
    return res.status(400).send({
      success: false,
      message: "taskId 不能为空",
    });
  }

  const task = imageTasks.get(taskId);
  if (!task) {
    return res.status(404).send({
      success: false,
      message: "任务不存在",
    });
  }

  if (task.status === "processing") {
    return res.send({
      success: true,
      status: "processing",
      message: "图片生成中",
    });
  }

  if (task.status === "completed") {
    return res.send({
      success: true,
      status: "completed",
      imageUrl: task.imageUrl,
    });
  }

  return res.send({
    success: false,
    status: "failed",
    message: "生成失败",
  });
});

app.post("/api/generate-image", async (req, res) => {
  try {
    const validation = validateImageRequest(req.body);
    if (!validation.valid) {
      return res.status(validation.statusCode).send({
        success: false,
        message: validation.message,
      });
    }

    const { imageUrl, responseType } = await callImage2EditApi({
      prompt: validation.prompt,
      ratio: validation.ratio,
      style: validation.style,
      referenceImageUrls: validation.referenceImageUrls,
    });

    return res.send({
      success: true,
      message: "image2 生成成功",
      imageUrl,
      debug: {
        provider: "image2",
        endpoint: "/v1/images/edits",
        model: IMAGE2_MODEL,
        responseType,
      },
    });
  } catch (error) {
    console.error("生成图片失败", error);
    return res.status(502).send({
      success: false,
      message: "image2 API 调用失败，请查看云托管运行日志",
    });
  }
});

app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}

bootstrap();
