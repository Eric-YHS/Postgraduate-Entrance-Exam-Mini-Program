Option Explicit

Dim shell, fso, projectFolder, starter
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectFolder = fso.GetParentFolderName(WScript.ScriptFullName)
starter = projectFolder & "\launch-student.cmd"

If Not fso.FileExists(starter) Then
    MsgBox "Required launcher file was not found: launch-student.cmd", vbCritical, "Yanban AI"
    WScript.Quit 1
End If

shell.Run Chr(34) & starter & Chr(34), 1, False
