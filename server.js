const express = require('express');
const fs = require('fs');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const { XMLParser } = require('fast-xml-parser');

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const DB_PATH = './db.json';
const CURRENCY_PATH = './currency.json';

// Чтение данных из db.json
function readDB() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return data ? JSON.parse(data) : []; // Возвращаем пустой массив, если данные отсутствуют
  } catch (err) {
    console.error('Ошибка при чтении DB:', err.message);
    return []; // Возвращаем пустой массив, если произошла ошибка
  }
}

// Запись данных в db.json
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Получение новостей
async function fetchNews() {
  const feeds = [
    'https://24.kg/rss/'
  ];
  const parser = new XMLParser();
  let news = readDB();

  for (const url of feeds) {
    try {
      const res = await axios.get(url);
      const parsed = parser.parse(res.data);
      const items = parsed.rss.channel.item;

      for (const item of items) {
        const title = item.title;
        const link = item.link;
        const description = item.description || '';
        const desc$ = cheerio.load(description);
        const img = desc$('img').first().attr('src');
        const text = desc$.text().trim().replace(/\s+/g, ' ').substring(0, 150) + '...';

        if (!news.some(n => n.link === link)) {
          let fullText = text;
          try {
            const articleRes = await axios.get(link);
            const $$ = cheerio.load(articleRes.data);
            const articleText = $$('.cont').text().trim() || $$('body').text().trim();
            fullText = articleText.replace(/\s+/g, ' ').substring(0, 5000);
          } catch (err) {
            console.warn('Не удалось загрузить полную новость:', link);
          }

          news.push({
            id: Date.now() + Math.floor(Math.random() * 1000),
            title,
            text,
            link,
            img: img || 'images/default.jpg',
            fullText
          });
        }
      }
    } catch (err) {
      console.error('Ошибка загрузки RSS:', url, err.message);
    }
  }

  writeDB(news.slice(-150));
}

// Получение курса валют
function fetchCurrency() {
  axios.get('https://www.nbkr.kg/XML/daily.xml')
    .then(res => {
      try {
        const parser = new XMLParser();
        const jsonData = parser.parse(res.data); // Преобразуем XML в JSON

        console.log("Данные о курсах валют:", JSON.stringify(jsonData, null, 2));  // Логируем все данные для диагностики

        // Проверяем, существует ли объект CurrencyRates и в нем массив Currency
        if (!jsonData.CurrencyRates || !jsonData.CurrencyRates.Currency) {
          console.error("Не удалось найти элементы Currency в XML.");
          return;
        }

        const result = {};
        const currencies = jsonData.CurrencyRates.Currency; // Извлекаем валюты

        // Массив с кодами валют, чтобы соотнести их с порядком
        const currencyCodes = ['USD', 'EUR', 'CNY', 'KZT', 'RUB'];

        // Обрабатываем каждую валюту
        currencies.forEach((currency, index) => {
          const code = currencyCodes[index];  // Используем код валюты из массива
          const nominal = parseFloat(currency['Nominal']);  // Номинал валюты
          const value = parseFloat(currency['Value'].replace(',', '.'));  // Курс валюты

          // Проверяем, что данные валидные
          if (code && value && nominal) {
            result[code] = value / nominal;  // Считываем курс с учетом номинала
          } else {
            console.warn(`Некорректные данные для валюты ${code}`);
          }
        });

        if (Object.keys(result).length === 0) {
          console.warn('Не удалось найти курсы валют в XML.');
        } else {
          fs.writeFileSync(CURRENCY_PATH, JSON.stringify(result, null, 2)); // Сохраняем данные в файл
          console.log('Данные о курсах валют сохранены в файл:', CURRENCY_PATH);
        }
      } catch (err) {
        console.error('Ошибка при парсинге XML:', err.message);
      }
    })
    .catch(err => {
      console.error('Ошибка загрузки курса валют:', err.message);
    });
}

// Периодическое обновление данных
cron.schedule('*/5 * * * *', fetchNews);
cron.schedule('0 * * * *', fetchCurrency);

// Получение новостей
app.get('/api/news', (req, res) => {
  res.json(readDB());
});

// Получение новостей по id
app.get('/api/news/:id', (req, res) => {
  const data = readDB();
  const item = data.find(n => n.id == req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

// Добавление новости
app.post('/api/news', (req, res) => {
  const data = readDB();
  const { title, text, link } = req.body;
  if (!title || !text || !link) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const newItem = {
    id: Date.now(),
    title,
    text,
    link,
    img: 'images/default.jpg',
    fullText: text
  };
  data.push(newItem);
  writeDB(data);
  res.status(201).json(newItem);
});

// Удаление новости
app.delete('/api/news/:id', (req, res) => {
  let data = readDB();
  const id = parseInt(req.params.id);
  const index = data.findIndex(n => n.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Not found' });
  }
  data.splice(index, 1);
  writeDB(data);
  res.json({ success: true });
});

// Новый маршрут для API валют

app.get('/api/currency', (req, res) => {
  try {
    const currencyData = fs.readFileSync(CURRENCY_PATH, 'utf-8');
    const parsedData = JSON.parse(currencyData);
    res.json(parsedData);  // Отдаем данные о курсах валют в формате JSON
  } catch (err) {
    console.error('Ошибка при чтении данных о валюте:', err.message);
    res.status(500).json({ error: 'Не удалось загрузить данные о валюте' });
  }
  const corsOptions = {
    origin: '*', // Разрешает все домены
  };
  app.use(cors());
});


// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`)
});
