import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b0f14" }}>
        <div style={{ width: 360, height: 360, borderRadius: 999, border: "36px solid #4da3ff", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 90, height: 90, borderRadius: 999, background: "#26a69a" }} />
        </div>
      </div>
    ),
    size,
  );
}
