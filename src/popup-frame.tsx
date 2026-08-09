import type { ReactNode } from "react";
import type { Theme } from "./theme";

export type PopupGeometry = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export function popupShadowVisible(
  geometry: PopupGeometry,
  terminalWidth: number,
  terminalHeight: number,
): boolean {
  return geometry.left + geometry.width < terminalWidth &&
    geometry.top + geometry.height < terminalHeight;
}

export function PopupFrame({
  theme,
  terminalWidth,
  terminalHeight,
  geometry,
  zIndex,
  title,
  border = true,
  borderColor = theme.border,
  padding = 1,
  children,
}: {
  theme: Theme;
  terminalWidth: number;
  terminalHeight: number;
  geometry: PopupGeometry;
  zIndex: number;
  title?: string;
  border?: boolean;
  borderColor?: string;
  padding?: number;
  children: ReactNode;
}) {
  const shadow = popupShadowVisible(geometry, terminalWidth, terminalHeight);
  return <>
    {shadow ? <>
      <box
        style={{
          position: "absolute",
          top: geometry.top + 1,
          left: geometry.left + geometry.width,
          width: 1,
          height: geometry.height,
          zIndex: zIndex - 1,
          flexDirection: "column",
        }}
      >
        {Array.from({ length: geometry.height }, (_, row) => (
          <text key={row} content="░" fg={theme.popupShadow} bg={theme.bg} wrapMode="none" />
        ))}
      </box>
      <box
        style={{
          position: "absolute",
          top: geometry.top + geometry.height,
          left: geometry.left + 1,
          width: geometry.width,
          height: 1,
          zIndex: zIndex - 1,
        }}
      >
        <text content={"░".repeat(geometry.width)} fg={theme.popupShadow} bg={theme.bg} wrapMode="none" />
      </box>
    </> : null}
    <box
      title={title}
      style={{
        position: "absolute",
        top: geometry.top,
        left: geometry.left,
        width: geometry.width,
        height: geometry.height,
        zIndex,
        border,
        borderColor,
        backgroundColor: theme.popupBg,
        flexDirection: "column",
        padding,
      }}
    >
      {children}
    </box>
  </>;
}
