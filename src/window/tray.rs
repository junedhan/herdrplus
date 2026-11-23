//! Windows close-to-tray for the main window. Quit still uses the app's
//! regular shutdown path, so the core and its terminals keep running.
use std::{cell::Cell, rc::Rc};

use gpui::Window;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    UI::{
        Shell::{
            DefSubclassProc, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
            RemoveWindowSubclass, SetWindowSubclass, Shell_NotifyIconW,
        },
        WindowsAndMessaging::{
            AppendMenuW, CreatePopupMenu, DestroyMenu, GCLP_HICON, GCLP_HICONSM, GetClassLongPtrW,
            GetCursorPos, IDI_APPLICATION, IsIconic, LoadIconW, MF_SEPARATOR, MF_STRING,
            PostMessageW, RegisterWindowMessageW, SW_HIDE, SW_RESTORE, SW_SHOW,
            SetForegroundWindow, ShowWindow, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON,
            TrackPopupMenu, WM_APP, WM_LBUTTONUP, WM_NCDESTROY, WM_NULL, WM_RBUTTONUP,
        },
    },
};

const TRAY_ID: u32 = 1;
const TRAY_MESSAGE: u32 = WM_APP + 0x249;
const VISIBILITY_MESSAGE: u32 = WM_APP + 0x24a;
const OPEN: usize = 1;
const QUIT: usize = 2;

pub(super) struct Tray(Rc<State>);

struct State {
    hwnd: HWND,
    taskbar_created: u32,
    hidden: Cell<bool>,
    alive: Cell<bool>,
    quit: Box<dyn Fn()>,
}

impl Tray {
    pub(super) fn new(window: &Window, quit: impl Fn() + 'static) -> Option<Self> {
        let hwnd = super::titlebar::win::hwnd(window)?;
        let state = Rc::new(State {
            hwnd,
            taskbar_created: unsafe { RegisterWindowMessageW(windows_sys::w!("TaskbarCreated")) },
            hidden: Cell::new(false),
            alive: Cell::new(true),
            quit: Box::new(quit),
        });
        // The Tray owns this Rc for the duration of the subclass registration.
        let installed = unsafe {
            SetWindowSubclass(
                hwnd,
                Some(subclass),
                TRAY_ID as usize,
                Rc::as_ptr(&state) as usize,
            )
        };
        (installed != 0).then_some(Self(state))
    }

    /// Only hide when the tray icon is available as a way back.
    pub(super) fn hide(&self) -> bool {
        let state = &self.0;
        if !state.alive.get() {
            return false;
        }
        if state.hidden.get() {
            return true;
        }
        if !state.add_icon() {
            return false;
        }
        state.hidden.set(true);
        if unsafe { PostMessageW(state.hwnd, VISIBILITY_MESSAGE, 0, 0) } != 0 {
            true
        } else {
            state.remove_icon();
            false
        }
    }

    pub(super) fn reveal(&self) {
        if self.0.hidden.get() {
            unsafe { PostMessageW(self.0.hwnd, VISIBILITY_MESSAGE, OPEN, 0) };
        }
    }
}

impl Drop for Tray {
    fn drop(&mut self) {
        if self.0.alive.get() {
            self.0.remove_icon();
            unsafe { RemoveWindowSubclass(self.0.hwnd, Some(subclass), TRAY_ID as usize) };
        }
    }
}

impl State {
    fn icon_data(&self) -> NOTIFYICONDATAW {
        NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: self.hwnd,
            uID: TRAY_ID,
            ..Default::default()
        }
    }

    fn add_icon(&self) -> bool {
        let mut data = self.icon_data();
        data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        data.uCallbackMessage = TRAY_MESSAGE;
        for (to, from) in data.szTip.iter_mut().zip("Herdr".encode_utf16()) {
            *to = from;
        }
        unsafe {
            data.hIcon = GetClassLongPtrW(self.hwnd, GCLP_HICONSM) as _;
            if data.hIcon.is_null() {
                data.hIcon = GetClassLongPtrW(self.hwnd, GCLP_HICON) as _;
            }
            if data.hIcon.is_null() {
                data.hIcon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);
            }
            Shell_NotifyIconW(NIM_ADD, &data) != 0
        }
    }

    fn remove_icon(&self) {
        if self.hidden.replace(false) {
            unsafe { Shell_NotifyIconW(NIM_DELETE, &self.icon_data()) };
        }
    }

    fn show(&self) {
        self.remove_icon();
        unsafe {
            ShowWindow(
                self.hwnd,
                if IsIconic(self.hwnd) != 0 {
                    SW_RESTORE
                } else {
                    SW_SHOW
                },
            );
            SetForegroundWindow(self.hwnd);
        }
    }

    fn menu(&self) {
        unsafe {
            let mut point = POINT::default();
            if GetCursorPos(&mut point) == 0 {
                return;
            }
            let menu = CreatePopupMenu();
            if menu.is_null() {
                return;
            }
            AppendMenuW(menu, MF_STRING, OPEN, windows_sys::w!("Open Herdr"));
            AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
            AppendMenuW(menu, MF_STRING, QUIT, windows_sys::w!("Quit Herdr"));
            // Windows dismisses a notification icon menu correctly when
            // its owner is foreground and receives a message after the menu.
            SetForegroundWindow(self.hwnd);
            let command = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
                point.x,
                point.y,
                0,
                self.hwnd,
                std::ptr::null(),
            ) as usize;
            DestroyMenu(menu);
            if !self.alive.get() {
                return;
            }
            PostMessageW(self.hwnd, WM_NULL, 0, 0);
            match command {
                OPEN => self.show(),
                QUIT => (self.quit)(),
                _ => {}
            }
        }
    }
}

unsafe extern "system" fn subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    let ptr = data as *const State;
    // Keep the state alive if a nested Windows message destroys the window
    // while the popup menu is running.
    let state = unsafe {
        Rc::increment_strong_count(ptr);
        Rc::from_raw(ptr)
    };
    match message {
        TRAY_MESSAGE if wparam == TRAY_ID as usize && state.hidden.get() => {
            match lparam as u32 {
                WM_LBUTTONUP => state.show(),
                WM_RBUTTONUP => state.menu(),
                _ => {}
            }
            return 0;
        }
        VISIBILITY_MESSAGE => {
            if wparam == OPEN {
                state.show();
            } else if state.hidden.get() {
                unsafe { ShowWindow(hwnd, SW_HIDE) };
            }
            return 0;
        }
        WM_NCDESTROY => {
            state.remove_icon();
            state.alive.set(false);
            unsafe { RemoveWindowSubclass(hwnd, Some(subclass), id) };
        }
        _ if state.taskbar_created != 0
            && message == state.taskbar_created
            && state.hidden.get() =>
        {
            // Explorer restarted while Herdr was tucked away.
            if !state.add_icon() {
                state.show();
            }
        }
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
