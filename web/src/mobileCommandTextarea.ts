export type MobileCommandTextareaAutosizeTarget = {
  scrollHeight: number;
  clientHeight?: number;
  offsetHeight?: number;
  style: {
    height: string;
  };
};

export function autosizeMobileCommandTextarea(
  textarea: MobileCommandTextareaAutosizeTarget | null,
) {
  if (!textarea) {
    return;
  }
  textarea.style.height = "auto";
  const borderHeight =
    typeof textarea.offsetHeight === "number" && typeof textarea.clientHeight === "number"
      ? Math.max(0, textarea.offsetHeight - textarea.clientHeight)
      : 0;
  textarea.style.height = `${textarea.scrollHeight + borderHeight}px`;
}
