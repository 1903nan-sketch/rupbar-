; Ganchos do instalador NSIS (Tauri v2).
; O servidor local roda como serviço do Windows ("RupBar Server"), independente
; da janela: celulares, cozinha e TV continuam funcionando com a janela fechada.

!macro NSIS_HOOK_PREINSTALL
  ; Atualização: para o serviço para liberar os arquivos em uso.
  nsExec::Exec 'sc stop RupBarServer'
  Sleep 4000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Instala/atualiza o serviço, regras de firewall (rede privada) e permissões
  ; da pasta de dados. O banco faz backup automático antes de migrar.
  nsExec::ExecToLog '"$INSTDIR\rupbar-service.exe" install'
  ; Permite que usuários comuns iniciem o serviço pela janela do RupBar.
  nsExec::Exec 'sc sdset RupBarServer D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove o serviço e as regras de firewall. Os dados em
  ; C:\ProgramData\RupBar são preservados (banco, backups e anexos).
  nsExec::ExecToLog '"$INSTDIR\rupbar-service.exe" uninstall'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
