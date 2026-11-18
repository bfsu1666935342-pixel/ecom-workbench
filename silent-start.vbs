' 静默启动工作台服务（不弹浏览器、不显示窗口）
' 由「开机自启」快捷方式调用；也可以手动双击。
Option Explicit
Dim sh, fso, base, exe, script, cmd

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = base

If fso.FileExists(base & "runtime\node.exe") Then
  exe = base & "runtime\node.exe"
Else
  exe = "node"
End If

script = base & "server\main.js"
cmd = """" & exe & """ """ & script & """ --no-open"

' 0 = 隐藏窗口，False = 不等待
On Error Resume Next
sh.Run cmd, 0, False
If Err.Number <> 0 Then
  ' 起不来时留个记录，方便排查
  Dim f
  Set f = fso.CreateTextFile(base & "silent-start-error.log", True)
  f.WriteLine Now & "  " & Err.Description
  f.WriteLine cmd
  f.Close
End If
