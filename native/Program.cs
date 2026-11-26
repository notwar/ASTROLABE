// ASTROLABE, native Windows version: one small exe, no install.
// A fixed-size window that shows the page in WebView2 (the Edge engine built into Windows).
// The page, the icon and the WebView2 helper DLLs are packed inside the exe and unpacked on start
// to %LOCALAPPDATA%\ASTROLABE. Compiled with the C# compiler that ships with Windows (C# 5).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Shown in the exe's Properties > Details. Change the version here for each release (and tag it vX.Y in git).
[assembly: AssemblyTitle("ASTROLABE")]
[assembly: AssemblyProduct("ASTROLABE")]
[assembly: AssemblyDescription("Brand colour to the value you type in any OCIO colour profile")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]
[assembly: AssemblyInformationalVersion("1.1")]

static class Program
{
    internal const string Title = "ASTROLABE";
    internal static string Home;

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string path);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int RegisterWindowMessage(string name);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint pid);

    // what a second start asks the running app to do
    internal static readonly int WM_OPEN = RegisterWindowMessage("AntiStudio.ASTROLABE.Open");
    internal static readonly int WM_PICK = RegisterWindowMessage("AntiStudio.ASTROLABE.Pick");

    // ASTROLABE.exe             opens the window
    // ASTROLABE.exe --pick      starts with the screen picker; the window opens once a colour is picked
    // ASTROLABE.exe --background  waits in the tray (how Windows starts it at login)
    [STAThread]
    static void Main(string[] args)
    {
        bool pick = Array.IndexOf(args, "--pick") >= 0, background = Array.IndexOf(args, "--background") >= 0;
        // One app only: starting it again passes the request on to the one already running.
        bool first;
        var mutex = new Mutex(true, "AntiStudio.ASTROLABE", out first);
        if (!first)
        {
            IntPtr h = FindWindow(null, Title);
            if (h != IntPtr.Zero && !background)
            {
                uint pid; GetWindowThreadProcessId(h, out pid);
                AllowSetForegroundWindow(pid); // let it come to the front
                PostMessage(h, pick ? WM_PICK : WM_OPEN, IntPtr.Zero, IntPtr.Zero);
            }
            return;
        }
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { } // per-monitor v2: sharp on any scaling

        Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Title);
        Directory.CreateDirectory(Home);
        // The native loader must be a file. Loading it now means the managed wrapper finds it by name.
        LoadLibrary(Extract("WebView2Loader.dll", Path.Combine(Home, "bin")));
        // The managed WebView2 DLLs load straight from the exe.
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            byte[] bytes = Resource(new AssemblyName(e.Name).Name + ".dll");
            return bytes == null ? null : Assembly.Load(bytes);
        };
        Extract("app.html", Path.Combine(Home, "app"));
        LoadSettings();
        ApplyAutoStart();

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Run(pick, background);
        GC.KeepAlive(mutex);
    }

    // Kept out of Main so WebView2 types are only touched after AssemblyResolve is set up.
    [MethodImpl(MethodImplOptions.NoInlining)]
    static void Run(bool pick, bool background) { Application.Run(new MainForm(pick, background)); }

    // --- settings: %LOCALAPPDATA%\ASTROLABE\settings.txt, one "name=value" per line ---
    static readonly Dictionary<string, string> settings = new Dictionary<string, string>();
    static string SettingsPath { get { return Path.Combine(Home, "settings.txt"); } }
    static void LoadSettings()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return;
            foreach (string line in File.ReadAllLines(SettingsPath))
            {
                int i = line.IndexOf('=');
                if (i > 0) settings[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
            }
        }
        catch (Exception) { }
    }
    internal static string Setting(string name, string fallback) { string v; return settings.TryGetValue(name, out v) ? v : fallback; }
    internal static void SetSetting(string name, string value)
    {
        settings[name] = value;
        try
        {
            var b = new StringBuilder();
            foreach (var kv in settings) b.Append(kv.Key).Append('=').Append(kv.Value).Append("\r\n");
            File.WriteAllText(SettingsPath, b.ToString());
        }
        catch (Exception) { }
    }

    // Not Ctrl+Shift+C: that is After Effects' Pre-compose. Win+Shift+C is also PowerToys Color Picker's
    // default: with that on, the gear menu says the keys are taken.
    internal const string DefaultHotkey = "Win+Shift+C";
    internal static string Hotkey { get { return Setting("hotkey", DefaultHotkey); } }

    // Start with Windows (on unless turned off): a Run entry for this user that starts it in the tray.
    // Written on every start, so it follows the exe if the exe moves.
    internal static bool AutoStart { get { return Setting("autostart", "1") == "1"; } }
    internal static bool OnTop { get { return Setting("ontop", "0") == "1"; } }
    internal static void ApplyAutoStart()
    {
        try
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
            {
                if (AutoStart) k.SetValue(Title, "\"" + Application.ExecutablePath + "\" --background");
                else if (k.GetValue(Title) != null) k.DeleteValue(Title, false);
            }
        }
        catch (Exception) { }
    }

    // "Win+Shift+C" -> modifier flags and key code for RegisterHotKey. Needs Ctrl, Alt or Win, and one
    // letter, digit or F key.
    internal static bool ParseHotkey(string s, out uint mods, out uint vk)
    {
        mods = 0; vk = 0;
        if (string.IsNullOrEmpty(s)) return false;
        foreach (string part in s.Split('+'))
        {
            string p = part.Trim();
            switch (p.ToLowerInvariant())
            {
                case "ctrl": mods |= 2; break;
                case "alt": mods |= 1; break;
                case "shift": mods |= 4; break;
                case "win": mods |= 8; break;
                default:
                    int n;
                    if (vk != 0) return false;
                    if (p.Length == 1 && char.IsLetterOrDigit(p[0]) && p[0] < 128) vk = char.ToUpperInvariant(p[0]);
                    else if (p.Length > 1 && char.ToUpperInvariant(p[0]) == 'F' && int.TryParse(p.Substring(1), out n) && n >= 1 && n <= 24) vk = (uint)(0x6F + n);
                    else return false;
                    break;
            }
        }
        return vk != 0 && (mods & 0xB) != 0;
    }

    static byte[] Resource(string name)
    {
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (s == null) return null;
            var ms = new MemoryStream();
            s.CopyTo(ms);
            return ms.ToArray();
        }
    }

    // Writes a packed file to disk, only when it changed (so a newer exe updates it).
    static string Extract(string name, string dir)
    {
        Directory.CreateDirectory(dir);
        string path = Path.Combine(dir, name);
        byte[] bytes = Resource(name);
        bool same = File.Exists(path) && new FileInfo(path).Length == bytes.Length && Equal(File.ReadAllBytes(path), bytes);
        if (!same) File.WriteAllBytes(path, bytes);
        return path;
    }

    static bool Equal(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }
}

class MainForm : Form
{
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

    readonly WebView2 web;
    readonly bool startHidden, pickAtStart;
    bool firstShow = true, everShown, started, pageReady, quitting;
    string pendingPick;          // a colour picked before the page had loaded
    bool hotkeyOk;
    bool autoFit; // "Fit colours into range automatically", as the page last reported it
    NotifyIcon tray;
    ToolStripMenuItem trayPick, trayAuto, trayTop;

    public MainForm(bool pick, bool background)
    {
        startHidden = pick || background;
        pickAtStart = pick;
        Text = Program.Title;
        // No Windows title bar (like PureRef): the page's header is the title bar, and its
        // minimise/close buttons show while the mouse is over the window.
        FormBorderStyle = FormBorderStyle.None;
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.None;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(236, 238, 242);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
        TopMost = Program.OnTop;

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = BackColor;
        Controls.Add(web);

        HandleCreated += (s, e) =>
        {
            SetCssClientSize(720, 600); // first guess; the page then asks for its exact size
            int round = 2; // Windows 11: rounded corners like a normal window (ignored on Windows 10)
            try { DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int)); } catch (Exception) { }
            RegisterShortcut(Program.Hotkey);
        };
        HandleDestroyed += (s, e) => UnregisterHotKey(Handle, 1);
        Load += (s, e) => Start();
        MakeTray();
    }

    async void Start()
    {
        if (started) return;
        started = true;
        await Init();
    }

    // Started hidden (--pick or --background): make the window and its page, but don't show it yet.
    protected override void SetVisibleCore(bool value)
    {
        if (firstShow && value && startHidden)
        {
            firstShow = false;
            CreateHandle();
            IntPtr h = web.Handle; // WebView2 needs its own window to start in
            base.SetVisibleCore(false);
            Start();
            if (pickAtStart) BeginInvoke(new Action(PickScreenColor));
            return;
        }
        firstShow = false;
        base.SetVisibleCore(value);
    }

    void ShowApp()
    {
        if (startHidden && !everShown) CenterToScreen(); // started in the tray: Windows didn't place it yet
        everShown = true;
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        SetForegroundWindow(Handle);
    }

    // --- the shortcut that starts the screen picker, from any app ---
    bool RegisterShortcut(string keys)
    {
        uint mods, vk;
        UnregisterHotKey(Handle, 1);
        hotkeyOk = Program.ParseHotkey(keys, out mods, out vk) && RegisterHotKey(Handle, 1, mods | 0x4000, vk); // 0x4000: no auto-repeat
        return hotkeyOk;
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312 && m.WParam.ToInt32() == 1) { PickScreenColor(); return; } // WM_HOTKEY
        if (m.Msg == Program.WM_PICK && Program.WM_PICK != 0) { PickScreenColor(); return; }
        if (m.Msg == Program.WM_OPEN && Program.WM_OPEN != 0) { ShowApp(); return; }
        base.WndProc(ref m);
    }

    // --- tray: the app keeps running there so the shortcut works with the window closed ---
    void MakeTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open ASTROLABE", null, (s, e) => ShowApp());
        trayPick = new ToolStripMenuItem("Pick a colour", null, (s, e) => PickScreenColor());
        menu.Items.Add(trayPick);
        trayAuto = new ToolStripMenuItem("Start with Windows", null, (s, e) => SetAutoStart(!Program.AutoStart));
        menu.Items.Add(trayAuto);
        trayTop = new ToolStripMenuItem("Always on top", null, (s, e) => SetOnTop(!Program.OnTop));
        menu.Items.Add(trayTop);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (s, e) => Quit());
        menu.Opening += (s, e) =>
        {
            trayPick.ShortcutKeyDisplayString = hotkeyOk ? Program.Hotkey : "";
            trayAuto.Checked = Program.AutoStart;
            trayTop.Checked = Program.OnTop;
        };
        tray = new NotifyIcon();
        try { tray.Icon = new Icon(Icon, SystemInformation.SmallIconSize); } catch (Exception) { tray.Icon = Icon; }
        tray.Text = Program.Title;
        tray.ContextMenuStrip = menu;
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowApp(); };
        tray.Visible = true;
    }

    void SetAutoStart(bool on)
    {
        Program.SetSetting("autostart", on ? "1" : "0");
        Program.ApplyAutoStart();
        SendSettings(null);
    }

    // stay above other apps' windows (kept between starts)
    void SetOnTop(bool on)
    {
        Program.SetSetting("ontop", on ? "1" : "0");
        TopMost = on;
        SendSettings(null);
    }

    void Quit()
    {
        quitting = true;
        Close();
    }

    // closing the window hides it to the tray; Quit (tray menu) or Windows shutting down ends the app
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); return; }
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (tray != null) { tray.Visible = false; tray.Dispose(); }
        base.OnFormClosed(e);
    }

    // the page's settings menu shows the shortcut and "start with Windows"
    void SendSettings(string error)
    {
        if (web.CoreWebView2 == null) return;
        web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"settings\",\"hotkey\":" + Json(Program.Hotkey) + ",\"hotkeyOk\":" + (hotkeyOk ? "true" : "false") +
            ",\"autostart\":" + (Program.AutoStart ? "true" : "false") + ",\"ontop\":" + (Program.OnTop ? "true" : "false") + ",\"error\":" + Json(error) + "}");
    }

    void ChangeShortcut(string keys)
    {
        uint mods, vk;
        if (!Program.ParseHotkey(keys, out mods, out vk)) { RegisterShortcut(Program.Hotkey); SendSettings(keys + " can't be a shortcut."); return; }
        if (RegisterShortcut(keys)) { Program.SetSetting("hotkey", keys); SendSettings(null); return; }
        RegisterShortcut(Program.Hotkey); // put the old one back
        SendSettings(keys + " is taken by another app. Pick other keys.");
    }

    // a borderless window that still has a shadow, a taskbar minimise/restore and Alt+F4
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ClassStyle |= 0x20000;            // CS_DROPSHADOW
            cp.Style |= 0x20000 | 0x80000;        // WS_MINIMIZEBOX | WS_SYSMENU
            return cp;
        }
    }

    double DisplayScale { get { uint dpi = IsHandleCreated ? GetDpiForWindow(Handle) : 96; return (dpi == 0 ? 96 : dpi) / 96.0; } }

    void SetCssClientSize(double w, double h)
    {
        double s = DisplayScale * (web.CoreWebView2 != null ? web.ZoomFactor : 1.0);
        // round up: a window half a pixel short of the page shows a scrollbar
        var size = new Size((int)Math.Ceiling(w * s - 0.01), (int)Math.Ceiling(h * s - 0.01));
        if (size.Width != ClientSize.Width || size.Height != ClientSize.Height) ClientSize = size;
    }

    async Task Init()
    {
        try
        {
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.Home, "webview"));
            await web.EnsureCoreWebView2Async(env);
        }
        // Without its page the app can do nothing: say why and quit for real (a plain Close() would only
        // hide it to the tray, leaving an empty app running). No owner window: it may be hidden.
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show("This PC is missing the Microsoft Edge WebView2 Runtime, which ASTROLABE needs.\n\nGet it from https://developer.microsoft.com/microsoft-edge/webview2/ and start the app again.",
                Program.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Quit();
            return;
        }
        catch (Exception e)
        {
            MessageBox.Show("ASTROLABE could not start its window.\n\n" + e.Message, Program.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Quit();
            return;
        }
        CoreWebView2 core = web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // no F5, Ctrl+F, Ctrl+P; typing and copy/paste still work
        core.SetVirtualHostNameToFolderMapping("ocio.app", Path.Combine(Program.Home, "app"), CoreWebView2HostResourceAccessKind.Allow);
        // The page reads OCIO configs and their LUT files through https://astrolabe.files/ (see OnFiles).
        core.AddWebResourceRequestedFilter("https://astrolabe.files/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnFiles;
        // Only the app page itself runs in this window.
        core.NavigationStarting += (s, e) =>
        {
            if (!e.Uri.StartsWith("https://ocio.app/", StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
        };
        core.NewWindowRequested += (s, e) =>
        {
            e.Handled = true; // links open in the normal browser, never inside the app
            if (e.Uri.StartsWith("http")) { try { Process.Start(e.Uri); } catch (Exception) { } }
        };
        // Right-click: only the edit commands that apply (copy, paste and so on), then "Always on top".
        // The browser's own items (back, reload, save as, print) mean nothing in this app.
        core.ContextMenuRequested += (s, e) =>
        {
            var keep = new HashSet<string> { "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll" };
            IList<CoreWebView2ContextMenuItem> items = e.MenuItems;
            for (int i = items.Count - 1; i >= 0; i--) if (!keep.Contains(items[i].Name)) items.RemoveAt(i);
            while (items.Count > 0 && items[items.Count - 1].Kind == CoreWebView2ContextMenuItemKind.Separator) items.RemoveAt(items.Count - 1);
            if (items.Count > 0) items.Add(core.Environment.CreateContextMenuItem("", null, CoreWebView2ContextMenuItemKind.Separator));
            CoreWebView2ContextMenuItem top = core.Environment.CreateContextMenuItem("Always on top", null, CoreWebView2ContextMenuItemKind.CheckBox);
            top.IsChecked = TopMost;
            top.CustomItemSelected += (s2, e2) => BeginInvoke(new Action(() => SetOnTop(!Program.OnTop)));
            items.Add(top);
            // the page owns this setting (gear menu); the menu shows what the page last reported and asks it to switch
            CoreWebView2ContextMenuItem fit = core.Environment.CreateContextMenuItem("Fit colours into range automatically", null, CoreWebView2ContextMenuItemKind.CheckBox);
            fit.IsChecked = autoFit;
            fit.CustomItemSelected += (s2, e2) => BeginInvoke(new Action(() =>
                core.PostWebMessageAsJson("{\"type\":\"autofit\",\"on\":" + (autoFit ? "false" : "true") + "}")));
            items.Add(fit);
        };
        core.WebMessageReceived += OnMessage;
        core.NavigationCompleted += (s, e) =>
        {
            pageReady = true;
            if (pendingPick != null) { core.PostWebMessageAsJson("{\"type\":\"picked-color\",\"hex\":" + Json(pendingPick) + "}"); pendingPick = null; }
        };
        core.Navigate("https://ocio.app/app.html");
    }

    // The page sends "fit:<width>:<height>" in CSS pixels whenever its size changes,
    // and "pick" to choose an OCIO config (answered with {"type":"picked","path":...}).
    void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string msg;
        try { msg = e.TryGetWebMessageAsString(); } catch (Exception) { return; }
        if (msg == "pick") { PickConfig(); return; }
        if (msg == "eyedropper") { PickScreenColor(); return; }
        // the page's header is the title bar
        if (msg == "drag") { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); return; } // WM_NCLBUTTONDOWN, HTCAPTION
        if (msg == "min") { WindowState = FormWindowState.Minimized; return; }
        if (msg == "close") { Hide(); return; } // to the tray
        if (msg == "settings") { SendSettings(null); return; }
        if (msg == "hotkey-pause") { UnregisterHotKey(Handle, 1); return; }
        if (msg == "hotkey-resume") { RegisterShortcut(Program.Hotkey); SendSettings(null); return; }
        if (msg != null && msg.StartsWith("hotkey:")) { ChangeShortcut(msg.Substring(7)); return; }
        if (msg != null && msg.StartsWith("autostart:")) { SetAutoStart(msg.Substring(10) == "1"); return; }
        if (msg != null && msg.StartsWith("ontop:")) { SetOnTop(msg.Substring(6) == "1"); return; }
        if (msg != null && msg.StartsWith("autofit:")) { autoFit = msg.Substring(8) == "1"; return; }
        string[] p = (msg ?? "").Split(':');
        double w, h;
        if (p.Length != 3 || p[0] != "fit") return;
        if (!double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out w)) return;
        if (!double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out h)) return;
        SetCssClientSize(Math.Min(Math.Max(w, 400), 2000), Math.Min(Math.Max(h, 300), 2000));
    }

    // Eyedropper for the whole screen: hide this window, freeze every monitor in a screenshot,
    // let the user click a pixel (with a magnifier), then answer {"type":"picked-color","hex":...}.
    // From the shortcut or the tray with the window closed: the window opens only once a colour is picked.
    bool picking;
    async void PickScreenColor()
    {
        if (picking) return;
        picking = true;
        bool wasShown = Visible && WindowState != FormWindowState.Minimized;
        Hide();
        await Task.Delay(wasShown ? 250 : 30); // let the windows behind repaint
        Rectangle virt = SystemInformation.VirtualScreen;
        var shot = new Bitmap(virt.Width, virt.Height, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
        using (Graphics g = Graphics.FromImage(shot)) g.CopyFromScreen(virt.Left, virt.Top, 0, 0, virt.Size, CopyPixelOperation.SourceCopy);
        var overlays = new List<PickOverlay>();
        bool done = false;
        Action<Color?> finish = null;
        finish = (c) =>
        {
            if (done) return;
            done = true;
            foreach (var o in overlays) o.Close();
            shot.Dispose();
            picking = false;
            if (!c.HasValue && !wasShown) return; // cancelled from the tray: stay there
            ShowApp();
            string hex = c.HasValue ? string.Format("#{0:X2}{1:X2}{2:X2}", c.Value.R, c.Value.G, c.Value.B) : null;
            if (pageReady) web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"picked-color\",\"hex\":" + Json(hex) + "}");
            else pendingPick = hex;
        };
        foreach (Screen s in Screen.AllScreens) overlays.Add(new PickOverlay(shot, virt.Location, s.Bounds, finish));
        foreach (var o in overlays) o.Show();
        foreach (var o in overlays) if (o.Bounds.Contains(Cursor.Position)) o.Activate();
    }

    string lastFolder;

    void PickConfig()
    {
        string path = null;
        using (var dlg = new OpenFileDialog())
        {
            dlg.Title = "Load an OCIO config";
            dlg.Filter = "OCIO config (*.ocio)|*.ocio|All files (*.*)|*.*";
            dlg.InitialDirectory = lastFolder ?? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (dlg.ShowDialog(this) == DialogResult.OK) { path = dlg.FileName; lastFolder = Path.GetDirectoryName(path); }
        }
        web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"picked\",\"path\":" + Json(path) + "}");
    }

    static string Json(string s)
    {
        if (s == null) return "null";
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '\\' || c == '"') b.Append('\\').Append(c);
            else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    // https://astrolabe.files/read?path=...  a file's bytes (configs and LUTs; read only)
    // https://astrolabe.files/env?name=...   an environment variable (configs can refer to them)
    // https://astrolabe.files/known          OCIO configs installed on this PC, as a JSON list
    void OnFiles(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        byte[] body = null;
        string type = "text/plain; charset=utf-8";
        try
        {
            var uri = new Uri(e.Request.Uri);
            var q = new Dictionary<string, string>();
            foreach (string part in uri.Query.TrimStart('?').Split('&'))
            {
                int i = part.IndexOf('=');
                if (i > 0) q[part.Substring(0, i)] = Uri.UnescapeDataString(part.Substring(i + 1).Replace('+', ' '));
            }
            string v;
            if (uri.AbsolutePath == "/read" && q.TryGetValue("path", out v) && File.Exists(v)) body = File.ReadAllBytes(v);
            else if (uri.AbsolutePath == "/env" && q.TryGetValue("name", out v))
            {
                string val = Environment.GetEnvironmentVariable(v);
                if (!string.IsNullOrEmpty(val)) body = Encoding.UTF8.GetBytes(val);
            }
            else if (uri.AbsolutePath == "/known") { body = Encoding.UTF8.GetBytes(KnownConfigs()); type = "application/json"; }
        }
        catch (Exception) { body = null; }
        int status = body == null ? 404 : 200;
        e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(new MemoryStream(body ?? new byte[0]), status, status == 200 ? "OK" : "Not Found",
            "Content-Type: " + type + "\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store");
    }

    // The configs that come with the apps we use (newest version of each), plus $OCIO.
    static string KnownConfigs()
    {
        var found = new List<string>();
        Action<string> add = (p) =>
        {
            if (!string.IsNullOrEmpty(p) && File.Exists(p) && !found.Exists(x => string.Equals(x, p, StringComparison.OrdinalIgnoreCase))) found.Add(p);
        };
        Action<string, string, bool> addAll = (dir, pattern, deep) =>
        {
            try
            {
                if (!Directory.Exists(dir)) return;
                string[] files = Directory.GetFiles(dir, pattern, deep ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly);
                Array.Sort(files, StringComparer.OrdinalIgnoreCase);
                foreach (string f in files) add(f);
            }
            catch (Exception) { }
        };
        // the highest version among folders like "Houdini 22.0.466" (skips "Houdini Launcher" and the like)
        Func<string, string, string> newest = (dir, pattern) =>
        {
            try
            {
                if (!Directory.Exists(dir)) return null;
                string best = null;
                long[] bestV = null;
                string prefix = pattern.TrimEnd('*');
                foreach (string d in Directory.GetDirectories(dir, pattern))
                {
                    string rest = Path.GetFileName(d).Substring(prefix.Length);
                    if (rest.Length == 0 || !char.IsDigit(rest[0])) continue;
                    var parts = new List<long>();
                    foreach (string n in System.Text.RegularExpressions.Regex.Split(rest, @"\D+")) { long x; if (long.TryParse(n, out x)) parts.Add(x); }
                    long[] v = parts.ToArray();
                    bool newer = bestV == null;
                    for (int i = 0; !newer && i < Math.Max(v.Length, bestV.Length); i++)
                    {
                        long mine = i < v.Length ? v[i] : -1, theirs = i < bestV.Length ? bestV[i] : -1;
                        if (mine != theirs) { newer = mine > theirs; break; }
                    }
                    if (newer) { best = d; bestV = v; }
                }
                return best;
            }
            catch (Exception) { return null; }
        };
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pd = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        add(Environment.GetEnvironmentVariable("OCIO"));
        string ae = newest(Path.Combine(pf, "Adobe"), "Adobe After Effects *");
        if (ae != null) addAll(Path.Combine(ae, @"Support Files\OpenColorIO-Configs"), "*.ocio", true);
        add(Path.Combine(pd, @"redshift\Data\OCIO\config.ocio"));
        string rs = newest(pf, "Maxon Redshift *");
        if (rs != null) addAll(Path.Combine(rs, @"Data\OCIO"), "*.ocio", false);
        string c4d = newest(pf, "Maxon Cinema 4D *");
        if (c4d != null) addAll(Path.Combine(c4d, @"resource\modules\c4d_base\ocio"), "*.ocio", false);
        string hou = newest(Path.Combine(pf, "Side Effects Software"), "Houdini *");
        if (hou != null) addAll(Path.Combine(hou, @"packages\ocio"), "*.ocio", false);
        string blender = newest(Path.Combine(pf, "Blender Foundation"), "Blender *");
        if (blender != null) addAll(blender, "config.ocio", true);
        string nuke = newest(pf, "Nuke*");
        if (nuke != null) addAll(Path.Combine(nuke, @"plugins\OCIOConfigs\configs"), "*.ocio", true);
        var b = new StringBuilder("[");
        for (int i = 0; i < found.Count; i++) b.Append(i == 0 ? "" : ",").Append(Json(found[i]));
        return b.Append("]").ToString();
    }
}

// One per monitor: shows the frozen screenshot with a magnifier under the cursor.
// Click picks, Esc or right-click cancels, arrow keys move one pixel, Enter picks.
class PickOverlay : Form
{
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
    [DllImport("user32.dll")] static extern IntPtr CreateIconIndirect(ref IconInfo info);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [StructLayout(LayoutKind.Sequential)]
    struct IconInfo { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }

    const int Cells = 11, Zoom = 12, Gap = 30, Chip = 14;
    Rectangle lastChip = Rectangle.Empty;

    // The cursor is the pipette from the app (and the After Effects panel): black with a white edge so it
    // shows on any background, its tip on the picked pixel.
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        uint dpi = GetDpiForWindow(Handle);
        try { Cursor = PipetteCursor((int)Math.Round(32 * (dpi == 0 ? 96 : dpi) / 96.0)); } catch (Exception) { Cursor = Cursors.Cross; }
    }

    static Cursor PipetteCursor(int size)
    {
        using (var bmp = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        {
            float k = size / 24f;
            using (Graphics g = Graphics.FromImage(bmp))
            using (var bulb = Rounded(9.5f, 1.5f, 5f, 7f, 2.5f))
            using (var collar = Rounded(8f, 8.5f, 8f, 2.2f, 1f))
            using (var tube = new System.Drawing.Drawing2D.GraphicsPath())
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                // the same drawing as the app's pipette icon: a 24-unit box, turned 45 degrees about its middle
                g.ScaleTransform(k, k);
                g.TranslateTransform(12, 12); g.RotateTransform(45); g.TranslateTransform(-12, -12);
                tube.AddLines(new[] { new PointF(10.6f, 11.3f), new PointF(10.6f, 18.5f), new PointF(12f, 22f), new PointF(13.4f, 18.5f), new PointF(13.4f, 11.3f) });
                using (var halo = new Pen(Color.White, 3.2f) { LineJoin = System.Drawing.Drawing2D.LineJoin.Round })
                {
                    g.DrawPath(halo, bulb); g.DrawPath(halo, collar); g.DrawPath(halo, tube);
                }
                using (var glass = new SolidBrush(Color.FromArgb(230, 255, 255, 255))) g.FillPath(glass, tube);
                using (var ink = new Pen(Color.Black, 1.4f) { LineJoin = System.Drawing.Drawing2D.LineJoin.Round })
                {
                    g.FillPath(Brushes.Black, bulb); g.FillPath(Brushes.Black, collar); g.DrawPath(ink, tube);
                }
            }
            // the tip (12, 22) after the turn: 45 degrees about (12, 12)
            int hx = (int)Math.Round((12 - 10 * Math.Sin(Math.PI / 4)) * k), hy = (int)Math.Round((12 + 10 * Math.Cos(Math.PI / 4)) * k);
            IntPtr icon = bmp.GetHicon();
            IconInfo info;
            GetIconInfo(icon, out info);
            DestroyIcon(icon);
            info.fIcon = false; info.xHotspot = hx; info.yHotspot = hy;
            IntPtr cur = CreateIconIndirect(ref info);
            DeleteObject(info.hbmMask); DeleteObject(info.hbmColor);
            return new Cursor(cur);
        }
    }

    static System.Drawing.Drawing2D.GraphicsPath Rounded(float x, float y, float w, float h, float r)
    {
        var p = new System.Drawing.Drawing2D.GraphicsPath();
        float d = Math.Min(r * 2, Math.Min(w, h));
        p.AddArc(x, y, d, d, 180, 90); p.AddArc(x + w - d, y, d, d, 270, 90);
        p.AddArc(x + w - d, y + h - d, d, d, 0, 90); p.AddArc(x, y + h - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    // the small chip with the colour under the tip: just below and right of the tip, where the pipette isn't
    Rectangle ChipRect(Point local)
    {
        int x = local.X + 8, y = local.Y + 8;
        if (x + Chip + 2 > Width) x = local.X - 8 - Chip;
        if (y + Chip + 2 > Height) y = local.Y - 8 - Chip;
        return new Rectangle(x - 2, y - 2, Chip + 4, Chip + 4);
    }
    readonly Bitmap shot;
    readonly Point origin;      // top-left of the whole desktop in the screenshot
    readonly Action<Color?> finish;
    Rectangle lastLoupe = Rectangle.Empty;

    public PickOverlay(Bitmap shot, Point origin, Rectangle bounds, Action<Color?> finish)
    {
        this.shot = shot; this.origin = origin; this.finish = finish;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        ShowInTaskbar = false;
        TopMost = true;
        KeyPreview = true;
        Bounds = bounds;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Opaque, true);
    }

    Color ColorAt(Point screen)
    {
        int x = Math.Min(Math.Max(screen.X - origin.X, 0), shot.Width - 1), y = Math.Min(Math.Max(screen.Y - origin.Y, 0), shot.Height - 1);
        return shot.GetPixel(x, y);
    }

    // where the magnifier and its label go, in this window's coordinates
    Rectangle LoupeRect(Point local)
    {
        int size = Cells * Zoom, h = size + 40;
        int x = local.X + Gap, y = local.Y + Gap;
        if (x + size > Width) x = local.X - Gap - size;
        if (y + h > Height) y = local.Y - Gap - h;
        return new Rectangle(x - 2, y - 2, size + 4, h + 4);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        Rectangle clip = e.ClipRectangle;
        g.DrawImage(shot, clip, new Rectangle(Left - origin.X + clip.X, Top - origin.Y + clip.Y, clip.Width, clip.Height), GraphicsUnit.Pixel);
        Point p = Cursor.Position;
        if (!Bounds.Contains(p)) return;
        Point local = new Point(p.X - Left, p.Y - Top);
        Rectangle r = LoupeRect(local);
        int size = Cells * Zoom, lx = r.X + 2, ly = r.Y + 2;
        // magnified pixels, one cell each, with a fine grid and the picked one outlined
        using (var bg = new SolidBrush(Color.FromArgb(29, 29, 29))) g.FillRectangle(bg, r);
        for (int j = 0; j < Cells; j++)
            for (int i = 0; i < Cells; i++)
            {
                Color c = ColorAt(new Point(p.X - Cells / 2 + i, p.Y - Cells / 2 + j));
                using (var b = new SolidBrush(c)) g.FillRectangle(b, lx + i * Zoom, ly + j * Zoom, Zoom, Zoom);
            }
        using (var grid = new Pen(Color.FromArgb(40, 0, 0, 0)))
            for (int k = 1; k < Cells; k++) { g.DrawLine(grid, lx + k * Zoom, ly, lx + k * Zoom, ly + size); g.DrawLine(grid, lx, ly + k * Zoom, lx + size, ly + k * Zoom); }
        int cx = lx + (Cells / 2) * Zoom, cy = ly + (Cells / 2) * Zoom;
        g.DrawRectangle(Pens.Black, cx - 1, cy - 1, Zoom + 1, Zoom + 1);
        g.DrawRectangle(Pens.White, cx, cy, Zoom - 1, Zoom - 1);
        // the colour as hex, and how to finish
        Color picked = ColorAt(p);
        string hex = string.Format("#{0:X2}{1:X2}{2:X2}", picked.R, picked.G, picked.B);
        using (var sw = new SolidBrush(picked)) g.FillRectangle(sw, lx, ly + size + 6, 12, 12);
        g.DrawRectangle(Pens.Gray, lx, ly + size + 6, 12, 12);
        using (var f = new Font("Consolas", 9f, FontStyle.Bold, GraphicsUnit.Point))
            TextRenderer.DrawText(g, hex, f, new Point(lx + 18, ly + size + 4), Color.FromArgb(233, 233, 233));
        using (var f = new Font("Segoe UI", 7.5f, GraphicsUnit.Point))
            TextRenderer.DrawText(g, "Click to pick · Esc to cancel", f, new Point(lx, ly + size + 20), Color.FromArgb(153, 153, 153));
        using (var edge = new Pen(Color.FromArgb(70, 70, 70))) g.DrawRectangle(edge, r.X, r.Y, r.Width - 1, r.Height - 1);
        // the chip next to the pipette: dark edge, white edge, then the colour
        Rectangle chip = ChipRect(local);
        using (var dark = new SolidBrush(Color.FromArgb(29, 29, 29))) g.FillRectangle(dark, chip);
        g.FillRectangle(Brushes.White, chip.X + 1, chip.Y + 1, chip.Width - 2, chip.Height - 2);
        using (var sw = new SolidBrush(picked)) g.FillRectangle(sw, chip.X + 2, chip.Y + 2, chip.Width - 4, chip.Height - 4);
    }

    void UpdateLoupe(Point screen)
    {
        if (!lastLoupe.IsEmpty) Invalidate(lastLoupe);
        if (!lastChip.IsEmpty) Invalidate(lastChip);
        if (Bounds.Contains(screen))
        {
            var local = new Point(screen.X - Left, screen.Y - Top);
            lastLoupe = LoupeRect(local);
            lastChip = ChipRect(local);
            Invalidate(lastLoupe);
            Invalidate(lastChip);
        }
        else { lastLoupe = Rectangle.Empty; lastChip = Rectangle.Empty; }
    }

    protected override void OnShown(EventArgs e) { base.OnShown(e); UpdateLoupe(Cursor.Position); }
    protected override void OnMouseMove(MouseEventArgs e) { UpdateLoupe(Cursor.Position); }
    protected override void OnMouseLeave(EventArgs e) { UpdateLoupe(Cursor.Position); }
    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) finish(ColorAt(Cursor.Position));
        else finish(null);
    }
    protected override void OnKeyDown(KeyEventArgs e)
    {
        Point p = Cursor.Position;
        switch (e.KeyCode)
        {
            case Keys.Escape: finish(null); return;
            case Keys.Enter: finish(ColorAt(p)); return;
            case Keys.Left: p.X--; break;
            case Keys.Right: p.X++; break;
            case Keys.Up: p.Y--; break;
            case Keys.Down: p.Y++; break;
            default: return;
        }
        Cursor.Position = p;
        UpdateLoupe(p);
    }
    // closing an overlay any other way (Alt+F4) cancels
    protected override void OnFormClosing(FormClosingEventArgs e) { base.OnFormClosing(e); finish(null); }
}
