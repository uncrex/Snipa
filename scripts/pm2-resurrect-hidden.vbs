Option Explicit

Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\uncr3\Clone3\Snipa"
shell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\uncr3\Clone3\Snipa\node_modules\pm2\bin\pm2"" resurrect", 0, True
