import test from "node:test";
import assert from "node:assert/strict";
import { youtubeSource, makeFeed, passwordHash, hash } from "../src/lib.js";

test("YouTube sources canonicalize video, list and author links", () => {
  assert.deepEqual(youtubeSource("https://youtu.be/dQw4w9WgXcQ?t=12"), {
    kind: "video",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  assert.equal(
    youtubeSource(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890",
    ).kind,
    "video",
  );
  assert.equal(
    youtubeSource("https://www.youtube.com/playlist?list=PL1234567890").kind,
    "playlist",
  );
  assert.equal(
    youtubeSource("https://www.youtube.com/@creator/videos").url,
    "https://www.youtube.com/@creator/videos",
  );
  assert.equal(
    youtubeSource("https://www.youtube.com/@creator/").url,
    "https://www.youtube.com/@creator/videos",
  );
  assert.equal(
    youtubeSource("https://www.youtube.com/channel/UC1234567890123456789012")
      .kind,
    "author",
  );
  for (const source of [
    "http://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://evil@youtube.com/watch?v=dQw4w9WgXcQ",
    "file:///etc/passwd",
    "https://youtube.com:444/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/redirect?q=http://127.0.0.1",
    "--exec=bad",
  ])
    assert.throws(() => youtubeSource(source));
});
test("RSS escapes user and remote content and uses per-channel media capabilities", () => {
  const rss = makeFeed(
    { title: "A < B & C", description: '"quoted"', feed_token: "abc" },
    [
      {
        id: "episode",
        title: "X & <script>\u0001",
        video_id: "dQw4w9WgXcQ",
        size: 30,
        duration: 15,
        created_at: 0,
      },
    ],
    "https://example.com",
  );
  assert.match(rss, /A &lt; B &amp; C/);
  assert.ok(!rss.includes("<script>"));
  assert.ok(!rss.includes("\u0001"));
  assert.match(rss, /https:\/\/example.com\/media\/abc\/episode.mp3/);
  assert.match(rss, /length="30" type="audio\/mpeg"/);
});
test("Passwords use independent salted derivation", async () => {
  const a = await passwordHash("a-very-long-password", "salt-a");
  assert.equal(a, await passwordHash("a-very-long-password", "salt-a"));
  assert.notEqual(a, await passwordHash("a-very-long-password", "salt-b"));
  assert.notEqual(a, await passwordHash("a-different-password", "salt-a"));
  assert.equal((await hash("session")).length, 64);
});
