/** Preferência de tema do painel (claro/escuro/sistema), guardada no navegador. */
export const THEME_KEY = 'rupbar-theme';

/** Executado antes da pintura para não "piscar" o tema errado. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;
