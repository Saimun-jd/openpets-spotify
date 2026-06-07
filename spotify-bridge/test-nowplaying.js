
import http from "node:http";
const req = http.get("http://127.0.0.1:8765/now-playing", (res) => {
  let data = "";
  res.on("data", (chunk) => (data += chunk));
  res.on("end", () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Response: ${data}`);
  });
});
req.on("error", (e) => console.error("Error:", e));
