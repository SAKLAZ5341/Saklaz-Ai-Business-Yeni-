' SAKLAZ agent: start without a console window (used by the startup task).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " """ & Replace(a, """", "") & """"
Next
WScript.Quit sh.Run("""" & dir & "\node.exe"" """ & dir & "\dist\saklaz-agent.mjs""" & args, 0, True)
