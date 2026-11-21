; YunX-WIN installer script (Inno Setup 6)
; Compiled by installer-package.ps1 with /DAppVersion=x.y.z
; Source: the portable output folder (release\YunX-WIN\) which already contains
; the custom launcher and skiko native libs.

#define AppName "YunX WIN"
#define AppNameEn "YunX-WIN"
#define AppCompany "木及"
#define AppExe "YunX-WIN.exe"
; 版本号单一来源：仓库根 version.txt —— installer-package.ps1 读取后经 /DAppVersion 传入。
; 这里刻意不留默认值，避免与 version.txt 漂移；直接调 ISCC 而不传参会在编译期报错。
#ifndef AppVersion
  #error AppVersion not defined - build via installer-package.ps1 (it passes /DAppVersion from version.txt)
#endif

[Setup]
AppId={{B4D7C1A2-6E3F-4B58-9A71-2C5D8E4F6071}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppCompany}
AppPublisherURL=https://github.com/wumuji/YunX-WIN
AppSupportURL=https://github.com/wumuji/YunX-WIN/issues
AppUpdatesURL=https://github.com/wumuji/YunX-WIN/releases
; 安装程序自身的文件版本信息（资源管理器 → setup.exe 属性 → 详细信息）
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppCompany}
VersionInfoDescription={#AppName} - 网盘分享链接解析与高速下载器
; lowest = no UAC prompt; {autopf} then maps to %LOCALAPPDATA%\Programs (ASCII-safe path
; for the bundled launcher). Remove PrivilegesRequired line to install per-machine instead.
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppNameEn}
DisableProgramGroupPage=yes
WizardStyle=modern
SetupIconFile=..\YunX-WIN.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
; 输出到 release\（相对本 .iss 所在目录）
OutputDir=..\release
OutputBaseFilename=YunX-WIN-setup-{#AppVersion}
ShowLanguageDialog=no

[Languages]
; 中文语言包随仓库分发（installer\ChineseSimplified.isl），构建不依赖外网
Name: "chs"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\release\YunX-WIN\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
; YunX Fetch 扩展的 native messaging host：按需唤醒 YunX Mini / 完整版
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.yunx.mini"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\com.yunx.mini.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.yunx.mini"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\com.yunx.mini.json"; Flags: uninsdeletekey

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  HostPath, ManifestPath, Content: String;
begin
  if CurStep = ssPostInstall then
  begin
    HostPath := ExpandConstant('{app}\native-host\YunX-MiniHost.exe');
    ManifestPath := ExpandConstant('{app}\native-host\com.yunx.mini.json');
    if FileExists(HostPath) then
    begin
      { JSON 里反斜杠要转义；StringChangeEx 原地改字符串并返回是否改动 }
      StringChangeEx(HostPath, '\', '\\', True);
      Content := '{"name":"com.yunx.mini","description":"YunX Mini / YunX WIN launcher","path":"' +
        HostPath +
        '","type":"stdio","allowed_origins":["chrome-extension://eoljolhfmkeekiagjocohmoklfdgldcj/"]}';
      { 浏览器只按 UTF-8 解析清单：必须用 SaveStringsToUTF8File；
        SaveStringToFile 在这个版本里始终按 ANSI/GBK 写，安装路径含中文时会变成非法 UTF-8 }
      SaveStringsToUTF8File(ManifestPath, [Content], False);
    end;
  end;
end;

[Icons]
; MessageBox 之外，Windows 通知（toast）也依赖开始菜单里存在带 AppUserModelID 的快捷方式；
; 未打包的桌面应用缺了它就发不出通知（Show 不报错但什么都不会出现）
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; AppUserModelID: "YunX.WIN"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon; AppUserModelID: "YunX.WIN"

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
