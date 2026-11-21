using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace YunX.MiniHost
{
    /// <summary>
    /// YunX Fetch 的 native messaging host。
    /// 只做一件事：按扩展请求启动 YunX Mini / 完整版，并返回本地桥端口。
    /// 不持有长连接，处理一条消息后退出。
    /// </summary>
    internal static class Program
    {
        private const int MiniPortStart = 37031;
        private const int MiniPortEnd = 37040;
        private const int FullPortStart = 37021;
        private const int FullPortEnd = 37030;

        private static int Main()
        {
            try
            {
                string message = ReadMessage();
                if (string.IsNullOrEmpty(message))
                {
                    WriteMessage("{\"ok\":false,\"error\":\"empty-message\"}");
                    return 0;
                }

                string action = ReadStringField(message, "action");
                string target = ReadStringField(message, "target");
                if (string.IsNullOrEmpty(target)) target = "mini";

                if (action == "status")
                {
                    WriteStatus();
                    return 0;
                }

                if (action != "ensure")
                {
                    WriteMessage("{\"ok\":false,\"error\":\"unknown-action\"}");
                    return 0;
                }

                bool mini = target != "full";
                int existing = FindPort(mini ? MiniPortStart : FullPortStart, mini ? MiniPortEnd : FullPortEnd, mini);
                if (existing > 0)
                {
                    WriteMessage("{\"ok\":true,\"port\":" + existing + ",\"mode\":\"" + (mini ? "mini" : "full") + "\",\"already\":true}");
                    return 0;
                }

                string appExe = ResolveAppExe();
                if (string.IsNullOrEmpty(appExe) || !File.Exists(appExe))
                {
                    WriteMessage("{\"ok\":false,\"error\":\"app-not-found\"}");
                    return 0;
                }

                var psi = new ProcessStartInfo
                {
                    FileName = appExe,
                    Arguments = mini ? "--mini" : "",
                    WorkingDirectory = Path.GetDirectoryName(appExe),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = mini ? ProcessWindowStyle.Hidden : ProcessWindowStyle.Normal
                };
                Process.Start(psi);

                int port = 0;
                for (int i = 0; i < 40; i++)
                {
                    Thread.Sleep(200);
                    port = FindPort(mini ? MiniPortStart : FullPortStart, mini ? MiniPortEnd : FullPortEnd, mini);
                    if (port > 0) break;
                }
                if (port <= 0)
                {
                    WriteMessage("{\"ok\":false,\"error\":\"timeout\"}");
                    return 0;
                }
                WriteMessage("{\"ok\":true,\"port\":" + port + ",\"mode\":\"" + (mini ? "mini" : "full") + "\"}");
            }
            catch (Exception error)
            {
                WriteMessage("{\"ok\":false,\"error\":\"" + Escape(error.Message) + "\"}");
            }
            return 0;
        }

        private static string ResolveAppExe()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            string config = Path.Combine(baseDir, "host.config.json");
            if (File.Exists(config))
            {
                string text = File.ReadAllText(config, Encoding.UTF8);
                string exe = ReadStringField(text, "appExe");
                if (!string.IsNullOrEmpty(exe))
                {
                    exe = exe.Replace("\\\\", "\\");
                    exe = Path.IsPathRooted(exe) ? exe : Path.GetFullPath(Path.Combine(baseDir, exe));
                    // 配置里的路径可能来自另一台机器（开发机 / 旧安装位置），不存在时继续走相对布局查找
                    if (File.Exists(exe)) return exe;
                }
            }

            // 安装版布局：<app>\native-host\YunX-MiniHost.exe → <app>\YunX-WIN.exe
            DirectoryInfo parent = Directory.GetParent(baseDir);
            if (parent != null)
            {
                string candidate = Path.Combine(parent.FullName, "YunX-WIN.exe");
                if (File.Exists(candidate)) return candidate;
            }
            string local = Path.Combine(baseDir, "YunX-WIN.exe");
            return File.Exists(local) ? local : "";
        }

        private static int FindPort(int start, int end, bool mini)
        {
            for (int port = start; port <= end; port++)
            {
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/ping");
                    request.Method = "GET";
                    request.Timeout = 160;
                    request.ReadWriteTimeout = 160;
                    request.UseDefaultCredentials = true;
                    using (var response = (HttpWebResponse)request.GetResponse())
                    using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        if (body.IndexOf("\"app\":\"yunx\"", StringComparison.Ordinal) < 0) continue;
                        string mode = ReadStringField(body, "mode");
                        if (mini ? mode == "mini" : mode == "full") return port;
                    }
                }
                catch
                {
                    // 端口未监听
                }
            }
            return 0;
        }

        private static void WriteStatus()
        {
            int mini = FindPort(MiniPortStart, MiniPortEnd, true);
            int full = FindPort(FullPortStart, FullPortEnd, false);
            WriteMessage("{\"ok\":true,\"mini\":" + (mini > 0 ? "{\"running\":true,\"port\":" + mini + "}" : "{\"running\":false}")
                + ",\"full\":" + (full > 0 ? "{\"running\":true,\"port\":" + full + "}" : "{\"running\":false}") + "}");
        }

        private static string ReadStringField(string text, string key)
        {
            Match match = Regex.Match(text ?? "", "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]*)\"", RegexOptions.IgnoreCase);
            return match.Success ? match.Groups[1].Value : "";
        }

        private static string ReadMessage()
        {
            using (Stream stdin = Console.OpenStandardInput())
            {
                byte[] lengthBytes = new byte[4];
                if (!ReadExact(stdin, lengthBytes, 4)) return "";
                int length = BitConverter.ToInt32(lengthBytes, 0);
                if (length <= 0 || length > 1024 * 1024) return "";
                byte[] body = new byte[length];
                if (!ReadExact(stdin, body, length)) return "";
                return Encoding.UTF8.GetString(body);
            }
        }

        private static bool ReadExact(Stream stream, byte[] buffer, int count)
        {
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buffer, offset, count - offset);
                if (read <= 0) return false;
                offset += read;
            }
            return true;
        }

        private static void WriteMessage(string json)
        {
            using (Stream stdout = Console.OpenStandardOutput())
            {
                byte[] body = Encoding.UTF8.GetBytes(json);
                byte[] length = BitConverter.GetBytes(body.Length);
                stdout.Write(length, 0, 4);
                stdout.Write(body, 0, body.Length);
                stdout.Flush();
            }
        }

        private static string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
