const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { init: initDB, Counter } = require("./db");

const IMAGE2_API_KEY = "这里填我的测试key";
const IMAGE2_BASE_URL = "https://3698520.xyz";
const FALLBACK_IMAGE_URL = "https://picsum.photos/1024/1024";

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "20mb" }));
app.use(cors());
app.use(logger);

// 首页
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 更新计数
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

// 获取计数
app.get("/api/count", async (req, res) => {
  const result = await Counter.count();
  res.send({
    code: 0,
    data: result,
  });
});

async function getTempImageUrls(referenceFileIDs) {
  // TODO: 后续接入微信云存储临时链接换取逻辑。
  // 当前前端传入的是 cloud:// fileID，不是公网 URL；第一版先原样返回，
  // 方便保持完整链路结构。接微信云存储后，这里应返回 image2 可访问的临时 URL。
  return referenceFileIDs;
}

async function callImage2Api({ prompt, ratio, style, imageUrls }) {
  // TODO: image2 API 参数格式确认后，在这里接入真实请求。
  // 预留常量：
  // - IMAGE2_API_KEY
  // - IMAGE2_BASE_URL
  //
  // 目前先打印调用参数并返回测试图片，保证小程序前端能收到 success: true 和 imageUrl。
  console.log("准备调用 image2 API", {
    baseUrl: IMAGE2_BASE_URL,
    hasApiKey: Boolean(IMAGE2_API_KEY),
    prompt,
    ratio,
    style,
    imageUrls,
  });

  return FALLBACK_IMAGE_URL;
}

app.post("/api/generate-image", async (req, res) => {
  try {
    const {
      prompt,
      ratio = "1:1",
      style = "真实摄影",
      referenceFileIDs,
    } = req.body || {};

    const normalizedPrompt = typeof prompt === "string" ? prompt.trim() : "";
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
    const imageUrl = await callImage2Api({
      prompt: normalizedPrompt,
      ratio,
      style,
      imageUrls,
    });

    res.send({
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
    console.error("生成图片失败", error);
    res.status(500).send({
      success: false,
      message: "生成图片失败，请稍后重试",
    });
  }
});

// 小程序调用，获取微信 Open ID
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
