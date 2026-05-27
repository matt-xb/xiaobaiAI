const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { init: initDB, Counter } = require("./db");

const TEST_IMAGE2_API_KEY = "这里填我的测试key";
const IMAGE2_API_KEY = process.env.IMAGE2_API_KEY || TEST_IMAGE2_API_KEY;
const IMAGE2_BASE_URL = "https://3698520.xyz";
const IMAGE2_MODEL = process.env.IMAGE2_MODEL || "gpt-image-1";
const FALLBACK_IMAGE_URL = "https://picsum.photos/1024/1024";

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

async function getTempImageUrls(referenceFileIDs) {
  // TODO: Convert WeChat cloud:// fileIDs to temporary public URLs.
  // The first real API version runs text-to-image only, so these URLs are
  // intentionally not sent to image2 yet.
  return referenceFileIDs;
}

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
  ].join("\n");
}

function extractImageUrl(data) {
  const firstImage = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!firstImage) {
    return "";
  }

  if (firstImage.url) {
    return firstImage.url;
  }

  if (firstImage.b64_json) {
    return `data:image/png;base64,${firstImage.b64_json}`;
  }

  return "";
}

async function callImage2Api({ prompt, ratio, style, imageUrls }) {
  if (!IMAGE2_API_KEY || IMAGE2_API_KEY === TEST_IMAGE2_API_KEY) {
    console.warn("IMAGE2_API_KEY 未配置，当前使用代码里的测试 key");
  }

  const endpoint = `${IMAGE2_BASE_URL.replace(/\/$/, "")}/v1/images/generations`;
  const requestBody = {
    model: IMAGE2_MODEL,
    prompt: buildImagePrompt({ prompt, ratio, style }),
    n: 1,
    size: getImageSizeByRatio(ratio),
    response_format: "url",
  };

  // imageUrls is reserved for the next image-to-image version. Do not include
  // it in the request before WeChat cloud fileIDs are converted to public URLs.
  console.log("Calling image2 API", {
    endpoint,
    model: IMAGE2_MODEL,
    size: requestBody.size,
    ratio,
    style,
    referenceImageCount: Array.isArray(imageUrls) ? imageUrls.length : 0,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMAGE2_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  let responseData = {};
  if (responseText) {
    try {
      responseData = JSON.parse(responseText);
    } catch (error) {
      console.error("image2 返回非 JSON 内容", responseText);
      throw new Error("image2 返回格式错误");
    }
  }

  if (!response.ok) {
    console.error("image2 API 请求失败", {
      status: response.status,
      statusText: response.statusText,
      body: responseData,
    });
    throw new Error("image2 API 请求失败");
  }

  const imageUrl = extractImageUrl(responseData);
  if (!imageUrl) {
    console.error("image2 API 响应中未找到图片 URL", responseData);
    throw new Error("image2 API 响应中未找到图片 URL");
  }

  return imageUrl;
}

app.post("/api/generate-image", async (req, res) => {
  try {
    const {
      prompt,
      ratio: rawRatio = "1:1",
      style: rawStyle = "真实摄影",
      referenceFileIDs,
    } = req.body || {};

    const normalizedPrompt = typeof prompt === "string" ? prompt.trim() : "";
    const ratio = normalizeRatio(rawRatio);
    const style = normalizeStyle(rawStyle);

    if (!normalizedPrompt) {
      return res.status(400).send({
        success: false,
        message: "prompt 不能为空",
      });
    }

    if (!Array.isArray(referenceFileIDs)) {
      return res.status(400).send({
        success: false,
        message: "referenceFileIDs 必须是数组",
      });
    }

    if (referenceFileIDs.length < 1) {
      return res.status(400).send({
        success: false,
        message: "referenceFileIDs 至少需要 1 张图片",
      });
    }

    const imageUrls = await getTempImageUrls(referenceFileIDs);

    try {
      const imageUrl = await callImage2Api({
        prompt: normalizedPrompt,
        ratio,
        style,
        imageUrls,
      });

      return res.send({
        success: true,
        message: "生成成功",
        imageUrl,
        debug: {
          prompt: normalizedPrompt,
          ratio,
          style,
          referenceFileIDs,
        },
      });
    } catch (error) {
      console.error("真实 image2 接口调用失败", error);
      return res.send({
        success: true,
        message: "真实接口失败，返回测试图",
        imageUrl: FALLBACK_IMAGE_URL,
        debug: {
          prompt: normalizedPrompt,
          ratio,
          style,
          referenceFileIDs,
        },
      });
    }
  } catch (error) {
    console.error("生成图片失败", error);
    res.status(500).send({
      success: false,
      message: "生成图片失败，请稍后重试",
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
