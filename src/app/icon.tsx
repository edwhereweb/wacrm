import { ImageResponse } from "next/og";

// Dynamic app icon route rendering the brand logo mark.
export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const LOGO_DATA_URI =
  "data:image/png;base64,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";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={LOGO_DATA_URI}
          width="32"
          height="32"
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    { ...size },
  );
}
