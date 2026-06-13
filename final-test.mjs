import http from "node:http";

async function testLocalBridge() {
  return new Promise((resolve, reject) => {
    const req = http.get("http://127.0.0.1:8765/now-playing", (res) => {
      let data = "";
      res.on("data", (d) => data += d);
      res.on("end", () => {
        console.log("✅ Local /now-playing success!", JSON.parse(data));
        resolve(JSON.parse(data));
      });
    });
    req.on("error", reject);
  });
}

async function testNgrokBridge() {
  const { default: https } = await import("node:https");
  return new Promise((resolve, reject) => {
    const req = https.get(
      "https://6b36-103-132-185-215.ngrok-free.app/now-playing",
      { headers: { "ngrok-skip-browser-warning": "true" } },
      (res) => {
        let data = "";
        res.on("data", (d) => data += d);
        res.on("end", () => {
          console.log("✅ Ngrok /now-playing success!", JSON.parse(data));
          resolve(JSON.parse(data));
        });
      }
    );
    req.on("error", reject);
  });
}

async function testSkipNext() {
  return new Promise((resolve, reject) => {
    const req = http.get("http://127.0.0.1:8765/next", (res) => {
      let data = "";
      res.on("data", (d) => data += d);
      res.on("end", () => {
        console.log("✅ /next success!", JSON.parse(data));
        resolve(JSON.parse(data));
      });
    });
    req.on("error", reject);
  });
}

async function runAllTests() {
  try {
    await testLocalBridge();
    await testNgrokBridge();
    console.log("\n🎉 All tests passed!");
  } catch (err) {
    console.error("\n❌ Test failed!", err);
  }
}

runAllTests();
