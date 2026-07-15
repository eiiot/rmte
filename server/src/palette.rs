use alacritty_terminal::vte::ansi::{Color, NamedColor};

pub const DEFAULT_FG: u32 = 0xd4d4d4;
pub const DEFAULT_BG: u32 = 0x121212;

/// Standard xterm 16-color palette.
const ANSI16: [u32; 16] = [
    0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5,
    0x666666, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
];

fn indexed(i: u8) -> u32 {
    match i {
        0..=15 => ANSI16[i as usize],
        16..=231 => {
            let i = i as u32 - 16;
            let (r, g, b) = (i / 36, (i / 6) % 6, i % 6);
            let c = |v: u32| if v == 0 { 0 } else { 55 + v * 40 };
            (c(r) << 16) | (c(g) << 8) | c(b)
        }
        232..=255 => {
            let v = 8 + (i as u32 - 232) * 10;
            (v << 16) | (v << 8) | v
        }
    }
}

fn dim(c: u32) -> u32 {
    let r = ((c >> 16) & 0xff) * 2 / 3;
    let g = ((c >> 8) & 0xff) * 2 / 3;
    let b = (c & 0xff) * 2 / 3;
    (r << 16) | (g << 8) | b
}

pub fn resolve(color: Color, is_fg: bool) -> u32 {
    match color {
        Color::Spec(rgb) => ((rgb.r as u32) << 16) | ((rgb.g as u32) << 8) | rgb.b as u32,
        Color::Indexed(i) => indexed(i),
        Color::Named(n) => match n {
            NamedColor::Black => ANSI16[0],
            NamedColor::Red => ANSI16[1],
            NamedColor::Green => ANSI16[2],
            NamedColor::Yellow => ANSI16[3],
            NamedColor::Blue => ANSI16[4],
            NamedColor::Magenta => ANSI16[5],
            NamedColor::Cyan => ANSI16[6],
            NamedColor::White => ANSI16[7],
            NamedColor::BrightBlack => ANSI16[8],
            NamedColor::BrightRed => ANSI16[9],
            NamedColor::BrightGreen => ANSI16[10],
            NamedColor::BrightYellow => ANSI16[11],
            NamedColor::BrightBlue => ANSI16[12],
            NamedColor::BrightMagenta => ANSI16[13],
            NamedColor::BrightCyan => ANSI16[14],
            NamedColor::BrightWhite => ANSI16[15],
            NamedColor::Foreground | NamedColor::BrightForeground => DEFAULT_FG,
            NamedColor::Background => DEFAULT_BG,
            NamedColor::Cursor => DEFAULT_FG,
            NamedColor::DimBlack => dim(ANSI16[0]),
            NamedColor::DimRed => dim(ANSI16[1]),
            NamedColor::DimGreen => dim(ANSI16[2]),
            NamedColor::DimYellow => dim(ANSI16[3]),
            NamedColor::DimBlue => dim(ANSI16[4]),
            NamedColor::DimMagenta => dim(ANSI16[5]),
            NamedColor::DimCyan => dim(ANSI16[6]),
            NamedColor::DimWhite => dim(ANSI16[7]),
            NamedColor::DimForeground => dim(DEFAULT_FG),
        },
        #[allow(unreachable_patterns)]
        _ => if is_fg { DEFAULT_FG } else { DEFAULT_BG },
    }
}
