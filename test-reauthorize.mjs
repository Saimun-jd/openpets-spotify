
import http from "node:http";
import open from "open";

function testEndpoint(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:8765${path}`, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

async function run() {
  console.log("Logging out…");
  const logout = await testEndpoint("/logout");
  console.log("Logout status:", logout.status);

  console.log("Opening login page in browser…");
  open("http://127.0.0.1:8765/login");
  console.log("Please complete Spotify authorization in the browser and press Enter to continue!");
  process.stdin.resume();
  process.stdin.on("data", async () => {
    console.log("Testing /next again…");
    try {
      const next = await testEndpoint("/next");
      console.log("/next status:", next.status);
      console.log("/next body:", next.body);
    } catch (e) {
      console.error("/next error:", e);
    }
    process.exit(0);
  });
}

run().catch(console.error);
