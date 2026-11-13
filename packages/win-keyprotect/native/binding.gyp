{
  "targets": [
    {
      "target_name": "keyprotect",
      "sources": ["keyprotect.c"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["crypt32.lib", "advapi32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "WarningLevel": "4",
                "WarnAsError": "true",
                "AdditionalOptions": ["/sdl", "/guard:cf"]
              },
              "VCLinkerTool": {
                "AdditionalOptions": ["/guard:cf", "/DYNAMICBASE", "/NXCOMPAT"]
              }
            }
          }
        ]
      ]
    }
  ]
}
