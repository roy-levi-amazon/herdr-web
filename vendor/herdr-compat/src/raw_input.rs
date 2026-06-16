#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawInputEvent {
    Key(crate::input::TerminalKey),
    Mouse(crossterm::event::MouseEvent),
    Paste(String),
    OuterFocusGained,
    OuterFocusLost,
}
