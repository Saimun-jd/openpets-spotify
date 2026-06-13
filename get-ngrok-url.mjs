import http from "node:http";

async function getNgrokUrl() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      "http://127.0.0.1:4040/api/tunnels",
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const json = JSON.parse(data);
          const httpsTunnel = json.tunnels.find(
            (t) => t.proto === "https"
          );
          if (httpsTunnel) resolve(httpsTunnel.public_url);
          else reject(new Error("No HTTPS tunnel found!"));
        });
      }
    );
    req.on("error", reject);
  });
}

getNgrokUrl().then((url) => console.log("Ngrok HTTPS URL:", url)).catch(console.error);
