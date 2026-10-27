// The working piece of the reader on /about: a public-domain passage in the
// visitor's language and what a group of friends said about its last
// paragraph. scripts/about-shots.js posts the same comments on a test copy
// of the site to take the phone pictures, so both tell the same story.
// `epub` is the Project Gutenberg book number; chapter and paragraph are the
// indexes BookFriends gives that EPUB (idx and data-p).
module.exports = {
  pt: {
    epub: 55752, chapter: 2, para: 4,
    book: 'Dom Casmurro', chapterTitle: 'Do titulo.',
    paragraphs: ['—Continue, disse eu accordando.', '—Já acabei, murmurou elle.', '—São muito bonitos.'],
    comments: [
      { name: 'Pedro', hours: 3, text: 'Ele cochilou no meio dos versos e ainda elogiou kkkk' },
      { name: 'Ana', hours: 2, reply: true, text: 'O “são muito bonitos” mais falso da literatura brasileira.' },
      { name: 'Lia', hours: 1, text: 'Três falas e já deu pra conhecer o narrador inteiro.' },
      { name: 'Pedro', hours: 0.5, spoiler: true, text: 'Guardem essa: ele faz isso o livro todo. Lembrem dela quando chegar na Capitu.' },
    ],
  },
  en: {
    epub: 345, chapter: 3, para: 15,
    book: 'Dracula', chapterTitle: 'Chapter I. Jonathan Harker’s Journal',
    paragraphs: [
      '“Do you know what day it is?” I answered that it was the fourth of May. She shook her head as she said again:',
      '“Oh, yes! I know that! I know that, but do you know what day it is?” On my saying that I did not understand, she went on:',
    ],
    comments: [
      { name: 'Pedro', hours: 3, text: 'Jonathan. Buddy. When a terrified old lady asks what day it is, you listen.' },
      { name: 'Ana', hours: 2, reply: true, text: 'He’s too busy writing down chicken recipes for Mina.' },
      { name: 'Lia', hours: 1, text: 'Read this in bed with the lights off. Bad idea.' },
      { name: 'Pedro', hours: 0.5, spoiler: true, text: 'Keep an eye on the crucifix she gives him. It matters in the castle.' },
    ],
  },
  es: {
    epub: 2000, chapter: 9, para: 68,
    book: 'Don Quijote de la Mancha', chapterTitle: 'Capítulo primero',
    paragraphs: [
      'Limpias, pues, sus armas, hecho del morrión celada, puesto nombre a su rocín y confirmándose a sí mismo, se dio a entender que no le faltaba otra cosa sino buscar una dama de quien enamorarse; porque el caballero andante sin amores era árbol sin hojas y sin fruto y cuerpo sin alma. Decíase él a sí:',
    ],
    comments: [
      { name: 'Pedro', hours: 3, text: 'Armadura lista, caballo con nombre… y lo siguiente es buscar novia jajaja' },
      { name: 'Ana', hours: 2, reply: true, text: '«Árbol sin hojas y sin fruto». Qué dramático, don Quijote.' },
      { name: 'Lia', hours: 1, text: 'Vamos por el capítulo uno y ya tengo personaje favorito.' },
      { name: 'Pedro', hours: 0.5, spoiler: true, text: 'Esperen a ver quién es la dama. No es quien él cree.' },
    ],
  },
};
