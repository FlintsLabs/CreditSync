# Handoff: ChatGPT Web → CreditSync MCP ผ่าน OpenAI Secure MCP Tunnel

วันที่: 2026-09-03
สถานะ: เอกสารสรุปสำหรับเริ่ม implementation/ทดลองเชื่อมต่อ

## เป้าหมาย

ให้ ChatGPT บนเว็บเรียกใช้ private CreditSync MCP ได้ โดยไม่ต้องเปิด CreditSync MCP endpoint สู่ public internet และยังคงใช้ authentication, tenant/actor binding และ inspect-before-write ของ CreditSync เหมือนเดิม

## ข้อสรุปจาก OpenAI documentation

- OpenAI Secure MCP Tunnel เป็น outbound-only connection จาก network ที่รัน `tunnel-client` ไปยัง OpenAI
- `tunnel-client` forward งานเข้า MCP server ภายในผ่าน HTTP หรือ stdio
- ใช้กับ ChatGPT Developer Mode และ private MCP ได้
- Tunnel ไม่รองรับ public plugin submission/distribution
- หากจะ publish public plugin ต้องมี stable public HTTPS MCP endpoint
- ChatGPT ต้องเปิด Developer Mode และสร้าง MCP app/connection โดยเลือก `Tunnel`

เอกสารอ้างอิง:

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://github.com/openai/tunnel-client/blob/master/docs/deployment/docker.md
- https://github.com/openai/tunnel-client/blob/master/docs/configuration.md

## Architecture ที่เสนอ

```text
ChatGPT Web Developer Mode
        |
        v
OpenAI Secure MCP Tunnel
        |
        v
tunnel-client project (Docker Compose)
        |
        | Docker network: creditsync_runtime
        v
CreditSync backend: http://backend:3000/mcp
```

โปรเจกต์ `tunnel-client` แยกจาก repository CreditSync ได้ โดยให้ Compose project ใหม่นี้ join external Docker network `creditsync_runtime` ของ CreditSync

## Official Docker image

ใช้ image ทางการ:

```text
ghcr.io/openai/tunnel-client
```

รองรับ Linux `amd64` และ `arm64` ควร pin exact release tag หรือ image digest ใน production หลีกเลี่ยงการใช้ `latest` โดยไม่ตั้งใจ

## Compose skeleton

```yaml
services:
  tunnel-client:
    image: ghcr.io/openai/tunnel-client:${TUNNEL_CLIENT_VERSION}
    restart: unless-stopped
    command:
      - run
      - --config
      - /etc/tunnel-client/config.yaml
    environment:
      CONTROL_PLANE_TUNNEL_ID: ${CONTROL_PLANE_TUNNEL_ID}
      LOG_LEVEL: info
      LOG_FORMAT: json
      HEALTH_LISTEN_ADDR: :8080
    volumes:
      - ./tunnel-client.yaml:/etc/tunnel-client/config.yaml:ro
      - ./secrets/control-plane-api-key:/run/secrets/control-plane-api-key:ro
      - ./secrets/creditsync-mcp-authorization:/run/secrets/creditsync-mcp-authorization:ro
    ports:
      - "127.0.0.1:18080:8080"
    networks:
      - creditsync_runtime

networks:
  creditsync_runtime:
    external: true
```

ตัวอย่าง `tunnel-client.yaml`:

```yaml
config_version: 1

control_plane:
  base_url: https://api.openai.com
  tunnel_id: tunnel_REPLACE_ME
  api_key: file:/run/secrets/control-plane-api-key

log:
  level: info
  format: json

health:
  listen_addr: :8080

mcp:
  server_urls:
    - channel: main
      url: http://backend:3000/mcp
  extra_headers:
    Authorization: file:/run/secrets/creditsync-mcp-authorization
```

ไฟล์ `creditsync-mcp-authorization` ต้องมี header value เต็มรูปแบบ แต่ห้าม commit:

```text
Bearer <CreditSync MCP token>
```

## Key และ permission boundary

- `CONTROL_PLANE_API_KEY`: runtime API key สำหรับให้ tunnel-client ติดต่อ OpenAI
- `CONTROL_PLANE_TUNNEL_ID`: tunnel ที่สร้าง/จัดการใน OpenAI Platform
- CreditSync MCP bearer token: secret แยกสำหรับเรียก `backend/mcp`
- ห้ามใช้ `OPENAI_ADMIN_KEY` เป็น daemon runtime key
- ห้ามใส่ key, token, URL credential หรือ secret ใน Git/plugin package
- การสร้าง/แก้ไข tunnel ต้องใช้ Tunnels Read + Manage
- การรัน client และเลือก tunnel ใน ChatGPT ต้องใช้ Tunnels Read + Use
- Tunnel ต้อง associate กับทั้ง Platform organization และ ChatGPT workspace เป้าหมาย

## งานที่ต้องตรวจสอบก่อนใช้งานจริง

1. สร้าง external network หากยังไม่มี:

   ```bash
   docker network create creditsync_runtime
   ```

2. ตรวจว่า CreditSync backend อยู่บน network นี้และ DNS ชื่อ `backend` resolve ได้
3. ตรวจว่า `MCP_ALLOWED_HOSTS` ของ CreditSync อนุญาต host ที่ request ภายในใช้จริง
4. ยืนยันว่า tunnel-client รองรับการส่ง `Authorization` header แบบ `file:` ไปยัง MCP upstream ตาม version ที่เลือก
5. ตั้ง permission และ associate tunnel กับ ChatGPT workspace
6. รัน `tunnel-client doctor --explain`
7. รัน Compose และตรวจ `/healthz`, `/readyz`, logs ที่ถูก redact
8. เชื่อมจาก ChatGPT Developer Mode แล้วตรวจ `tools/list`
9. ทดสอบ read-only tool ก่อน เช่น borrower search/portfolio
10. ทดสอบ write flow เฉพาะ disposable/test tenant และต้องคง `inspect → preview → explicit confirmation → post`

## คำสั่ง CLI ที่เกี่ยวข้อง

```bash
tunnel-client help quickstart
tunnel-client help samples
tunnel-client profiles samples list
tunnel-client doctor --profile creditsync --explain
tunnel-client run --profile creditsync
tunnel-client admin tunnels list
```

`tunnel-client admin tunnels ...` ใช้จัดการ tunnel metadata และต้องใช้ admin key/permission ที่เหมาะสม ส่วน daemon ใช้ runtime key แยกกัน

## สิ่งที่ไม่ควรทำ

- อย่าเปิด port inbound เพื่อ tunnel-client
- อย่าเอา OpenAI Secure MCP Tunnel ไปใช้เป็น public plugin endpoint
- อย่าใส่ bearer token ใน `.env` ที่ commit, Compose command line, logs หรือ plugin package
- อย่าให้ model คำนวณยอดเงินเองหรือ bypass CreditSync preview/confirmation
- อย่าทดสอบการเงินจริงใน production tenant

## Current CreditSync state

CreditSync มี stateless Streamable HTTP MCP ที่ `/mcp`, bearer authentication, fixed tenant/actor, tool contract และ plugin skills อยู่แล้ว โดย repository plugin ปัจจุบันมี private app reference สำหรับ Codex แต่การใช้งาน ChatGPT Web ผ่าน Secure MCP Tunnel ต้องสร้าง Developer Mode MCP connection แยกใน ChatGPT

เอกสารนี้ยังไม่ยืนยันว่า tunnel ถูกสร้าง, key ใช้งานได้, หรือ live ChatGPT connection สำเร็จแล้ว ต้องทำ runtime verification ตาม checklist ก่อนรายงานว่าเชื่อมต่อสำเร็จ
