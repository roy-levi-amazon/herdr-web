export type MobileCommandTextareaAutosizeTarget = {
  scrollHeight: number;
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
  textarea.style.height = `${textarea.scrollHeight}px`;
}
