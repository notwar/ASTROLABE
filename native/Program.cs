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
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("1.0")]

static class Program
{
    internal const string Title = "ASTROLABE";
    internal static string Home;

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string path);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);

    [STAThread]
    static void Main()
    {
        // One window only: starting it again brings the open one to the front.
        bool first;
        var mutex = new Mutex(true, "AntiStudio.ASTROLABE", out first);
        if (!first)
        {
            IntPtr h = FindWindow(null, Title);
            if (h != IntPtr.Zero) { if (IsIconic(h)) ShowWindow(h, 9); SetForegroundWindow(h); }
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

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Run();
        GC.KeepAlive(mutex);
    }

    // Kept out of Main so WebView2 types are only touched after AssemblyResolve is set up.
    [MethodImpl(MethodImplOptions.NoInlining)]
    static void Run() { Application.Run(new MainForm()); }

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

    readonly WebView2 web;

    public MainForm()
    {
        Text = Program.Title;
        FormBorderStyle = FormBorderStyle.FixedSingle; // no resize border
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.None;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(236, 238, 242);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = BackColor;
        Controls.Add(web);

        HandleCreated += (s, e) => SetCssClientSize(720, 600); // first guess; the page then asks for its exact size
        Load += async (s, e) => await Init();
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
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(this, "This PC is missing the Microsoft Edge WebView2 Runtime, which ASTROLABE needs.\n\nGet it from https://developer.microsoft.com/microsoft-edge/webview2/ and start the app again.",
                Program.Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Close();
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
        core.WebMessageReceived += OnMessage;
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
        string[] p = (msg ?? "").Split(':');
        double w, h;
        if (p.Length != 3 || p[0] != "fit") return;
        if (!double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out w)) return;
        if (!double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out h)) return;
        SetCssClientSize(Math.Min(Math.Max(w, 400), 2000), Math.Min(Math.Max(h, 300), 2000));
    }

    // Eyedropper for the whole screen: hide this window, freeze every monitor in a screenshot,
    // let the user click a pixel (with a magnifier), then answer {"type":"picked-color","hex":...}.
    bool picking;
    async void PickScreenColor()
    {
        if (picking) return;
        picking = true;
        Hide();
        await Task.Delay(250); // let the windows behind repaint
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
            Show();
            Activate();
            picking = false;
            string hex = c.HasValue ? string.Format("#{0:X2}{1:X2}{2:X2}", c.Value.R, c.Value.G, c.Value.B) : null;
            web.CoreWebView2.PostWebMessageAsJson("{\"type\":\"picked-color\",\"hex\":" + Json(hex) + "}");
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
    const int Cells = 11, Zoom = 12, Gap = 22;
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
        Cursor = Cursors.Cross;
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
    }

    void UpdateLoupe(Point screen)
    {
        if (!lastLoupe.IsEmpty) Invalidate(lastLoupe);
        if (Bounds.Contains(screen))
        {
            lastLoupe = LoupeRect(new Point(screen.X - Left, screen.Y - Top));
            Invalidate(lastLoupe);
        }
        else lastLoupe = Rectangle.Empty;
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
