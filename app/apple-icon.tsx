import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b0f14" }}>
        <div style={{ width: 128, height: 128, borderRadius: 999, border: "14px solid #4da3ff", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 32, height: 32, borderRadius: 999, background: "#26a69a" }} />
        </div>
      </div>
    ),
    size,
  );
}
