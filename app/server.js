const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_FILE = "./config.json";

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  return {
    linkedin_client_id: process.env.LINKEDIN_CLIENT_ID || "",
    linkedin_client_secret: process.env.LINKEDIN_CLIENT_SECRET || "",
    api_key: process.env.API_KEY || crypto.randomBytes(32).toString("hex"),
    access_token: "",
    linkedin_person_urn: "",
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const cfg = loadConfig();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!key || key !== cfg.api_key) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

// ─── LinkedIn OAuth ────────────────────────────────────────────────────────────
const REDIRECT_URI = process.env.REDIRECT_URI || "https://postautobot.getmicroservices.co/auth/callback";

app.get("/auth/linkedin", (req, res) => {
  const cfg = loadConfig();
  if (!cfg.linkedin_client_id) {
    return res.redirect("/?error=missing_credentials");
  }
  const state = crypto.randomBytes(16).toString("hex");
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${cfg.linkedin_client_id}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid%20profile%20w_member_social%20r_member_social&state=${state}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const cfg = loadConfig();
  const { code } = req.query;
  const redirectUri = REDIRECT_URI;

  try {
    // Exchange code for token
    const tokenRes = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: cfg.linkedin_client_id,
        client_secret: cfg.linkedin_client_secret,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    cfg.access_token = tokenRes.data.access_token;

    // Get person URN
    const profileRes = await axios.get("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${cfg.access_token}` },
    });
    cfg.linkedin_person_urn = `urn:li:person:${profileRes.data.sub}`;

    saveConfig(cfg);
    res.redirect("/?connected=true");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.redirect("/?error=auth_failed");
  }
});

// ─── Config API ───────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  const cfg = loadConfig();
  res.json({
    connected: !!cfg.access_token,
    has_credentials: !!cfg.linkedin_client_id,
    person_urn: cfg.linkedin_person_urn || null,
    api_key: cfg.api_key,
  });
});

app.post("/api/config", (req, res) => {
  const cfg = loadConfig();
  const { linkedin_client_id, linkedin_client_secret } = req.body;
  if (linkedin_client_id) cfg.linkedin_client_id = linkedin_client_id;
  if (linkedin_client_secret) cfg.linkedin_client_secret = linkedin_client_secret;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.post("/api/regenerate-key", (req, res) => {
  const cfg = loadConfig();
  cfg.api_key = crypto.randomBytes(32).toString("hex");
  saveConfig(cfg);
  res.json({ api_key: cfg.api_key });
});

// ─── Post to LinkedIn ──────────────────────────────────────────────────────────
/**
 * POST /api/post
 * Headers: x-api-key: <your_api_key>
 * Body: {
 *   "text": "Main post text / blog summary",
 *   "title": "(optional) Article title",
 *   "url": "(optional) Link to full article",
 *   "visibility": "PUBLIC" | "CONNECTIONS"  (default: PUBLIC)
 * }
 */
app.post("/api/post", requireApiKey, async (req, res) => {
  const cfg = loadConfig();

  if (!cfg.access_token) {
    return res.status(400).json({ error: "LinkedIn not connected. Visit the dashboard to authenticate." });
  }

  const { text, title, url, visibility = "PUBLIC" } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Missing required field: text" });
  }

  try {
    // Build the UGC post payload
    const payload = {
      author: cfg.linkedin_person_urn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: url ? "ARTICLE" : "NONE",
          ...(url && {
            media: [
              {
                status: "READY",
                originalUrl: url,
                ...(title && { title: { text: title } }),
              },
            ],
          }),
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": visibility,
      },
    };

    const response = await axios.post(
      "https://api.linkedin.com/v2/ugcPosts",
      payload,
      {
        headers: {
          Authorization: `Bearer ${cfg.access_token}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );

    const postId = response.headers["x-restli-id"] || response.data.id;
    console.log(`✅ Posted to LinkedIn: ${postId}`);

    res.json({
      success: true,
      post_id: postId,
      post_url: `https://www.linkedin.com/feed/update/${postId}`,
    });
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error("LinkedIn post failed:", errData);
    res.status(500).json({ error: "Failed to post to LinkedIn", details: errData });
  }
});

// ─── Get Recent Posts ────────────────────────────────────────────────────────────
/**
 * GET /api/posts?count=10
 * Returns recent posts by the authenticated person.
 */
app.get("/api/posts", requireApiKey, async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.access_token) return res.status(400).json({ error: "LinkedIn not connected." });

  const count = parseInt(req.query.count) || 10;
  const authorEncoded = encodeURIComponent(cfg.linkedin_person_urn);

  try {
    const response = await axios.get(
      `https://api.linkedin.com/v2/ugcPosts?q=authors&authors=List(${authorEncoded})&count=${count}&sortBy=LAST_MODIFIED`,
      {
        headers: {
          Authorization: `Bearer ${cfg.access_token}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );

    const posts = (response.data.elements || []).map((p) => ({
      id: p.id,
      text: p.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text || "",
      created: p.created?.time ? new Date(p.created.time).toISOString() : null,
      url: `https://www.linkedin.com/feed/update/${p.id}`,
    }));

    res.json({ success: true, count: posts.length, posts });
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error("Fetch posts failed:", errData);
    res.status(500).json({ error: "Failed to fetch posts", details: errData });
  }
});

// ─── Get Comments on a Post ───────────────────────────────────────────────────
/**
 * GET /api/comments?post_id=urn:li:ugcPost:XXXX
 * Returns comments on the specified post.
 */
app.get("/api/comments", requireApiKey, async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.access_token) return res.status(400).json({ error: "LinkedIn not connected." });

  const { post_id } = req.query;
  if (!post_id) return res.status(400).json({ error: "Missing post_id" });

  const encoded = encodeURIComponent(post_id);

  try {
    const response = await axios.get(
      `https://api.linkedin.com/v2/socialActions/${encoded}/comments?count=50`,
      {
        headers: {
          Authorization: `Bearer ${cfg.access_token}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );

    const comments = (response.data.elements || []).map((c) => ({
      id: c.id,
      actor_urn: c.actor,
      text: c.message?.text || "",
      created: c.created?.time ? new Date(c.created.time).toISOString() : null,
      likes: c.likesSummary?.totalLikes || 0,
    }));

    res.json({ success: true, post_id, count: comments.length, comments });
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error("Fetch comments failed:", errData);
    res.status(500).json({ error: "Failed to fetch comments", details: errData });
  }
});

// ─── Post a Comment ───────────────────────────────────────────────────────────
/**
 * POST /api/comment
 * Headers: x-api-key: <your_api_key>
 * Body: {
 *   "post_id": "urn:li:ugcPost:XXXX",   // post to comment on
 *   "text": "Your reply text",
 *   "parent_comment_id": "(optional) urn:li:comment:(urn:li:ugcPost:XXX,YYY)"  // for replies to comments
 * }
 */
app.post("/api/comment", requireApiKey, async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.access_token) return res.status(400).json({ error: "LinkedIn not connected." });

  const { post_id, text, parent_comment_id } = req.body;
  if (!post_id || !text) return res.status(400).json({ error: "Missing post_id or text" });

  const encoded = encodeURIComponent(post_id);

  const payload = {
    actor: cfg.linkedin_person_urn,
    message: { text },
    ...(parent_comment_id && { parentComment: parent_comment_id }),
  };

  try {
    const response = await axios.post(
      `https://api.linkedin.com/v2/socialActions/${encoded}/comments`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${cfg.access_token}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );

    const commentId = response.headers["x-restli-id"] || response.data.id;
    console.log(`✅ Comment posted: ${commentId}`);

    res.json({ success: true, comment_id: commentId });
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error("Post comment failed:", errData);
    res.status(500).json({ error: "Failed to post comment", details: errData });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const cfg = loadConfig();
  saveConfig(cfg); // Ensure config file exists with api_key
  console.log(`\n🤖 PostAutoBot running at http://localhost:${PORT}`);
  console.log(`🔑 Your API key: ${loadConfig().api_key}`);
  console.log(`📋 API docs:     http://localhost:${PORT}/\n`);
});
