// Place names, for one question: is what is left of a firm's name only a PLACE?
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT IS FOR
//
// companyShortName (company-short-name.ts, beside this file) shortens "Kessel Consulting"
// to "Kessel", so a follow-up email can say "so Kessel can win the right clients". Since
// the sixth reading (2026-10-03) it does that whenever what is left names something, and
// an ordinary word does ("Harbour Consulting" is "Harbour"). A PLACE does not: "Denver
// Advisory Partners" has to stay as it is, because "so Denver can win the right clients"
// names a city, and the reader's firm is not a city. The operator: "places and trade words
// keep the full name". A name on this list is a place, and the firm keeps its full name.
//
// HOW IT IS READ, in company-short-name.ts:
//
//   - a remainder that is a place TAKEN WHOLE keeps the full name ("New York Consulting")
//   - a remainder of several words is also read WORD BY WORD: a word that is a place is
//     not what makes it a name, but any other word is, an ordinary word included since
//     the sixth reading. So "Kessel Denver Consulting" is "Kessel Denver" and "Denver Tax
//     Advisors" is "Denver Tax" (until the sixth reading it kept its full name, because
//     "tax" was on the common-word list)
//   - and a word inside any run of two words or more that is a place is a place's word
//     (the second round of the review, 2026-10-02), so "Los Angeles Advisors" keeps its
//     full name although "los" and "angeles" are on no list alone. "Los Angeles Tax
//     Advisors" is "Los Angeles Tax", through "Tax"
//   - a hyphenated word is read with its hyphens as spaces, so "Asia-Pacific" is the place
//     "asia pacific" if listed, and is otherwise judged by its parts
//   - a firm whose WHOLE name is a place, with no generic word after it ("Denver Ltd", "New
//     York Ltd", "Greater Manchester LLC"), has no longer form to keep and is "your firm"
//
// ═════════════════════════════════════════════════════════════════════════════
// IT IS A LIST, AND A PLACE NOBODY LISTED STILL PASSES
//
// Written by hand from general knowledge on 2026-10-02: every country by its common
// English name, the continents and the regions firms name themselves after, the first-level
// divisions of the countries this product is most likely to write to, and several hundred
// cities, heaviest on the United States, the United Kingdom, Canada, Ireland, Australia and
// New Zealand. It is not a gazetteer and it must not be read as one. A market town, a
// suburb, a county seat or a district that is not here is read as a name.
//
// THE COST OF A MISS IS ONE ODD SENTENCE: a firm called by the town it is named after.
// That cost came in with the shorter name. Before the fifth reading nothing was shortened,
// and such a firm was called by its full name.
//
// THE COST OF A HIT IS SMALL. A firm kept at its full name is never called the wrong
// thing. So the list leans long on purpose, and holds names that are also surnames, first
// names or ordinary words ("Jackson", "Lincoln", "Victoria", "Reading", "Mobile"). A firm
// named after a person called Jackson keeps "Jackson Consulting", which is what it is
// called. The one real loss is the firm whose whole name is such a word: "Jackson Ltd" is
// "your firm".
//
// THE FORM OF AN ENTRY. Lower case. No accents ("zurich", "quebec", "sao paulo"). No full
// stops ("st louis"). A hyphen where the name is written with one ("winston-salem"). A
// caller has to bring its word to the same form before it looks.
//
// ONE WORD AND SEVERAL. Most of what the short name rule meets is one word, because a
// remainder is usually one word. The names of several words are here for the remainder
// that is a whole place ("New York", "Hong Kong"), which the rule also checks.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE REVIEW OF THE FIFTH READING, 2026-10-02: WHAT WAS ADDED, AND WHAT IS A RULE
//
// A sample of 162 places found 30 missing. Every single-word city, state, county and
// country sampled was here. The misses were three kinds, and each got a different answer:
//
//   - TWO-WORD REGIONS MADE OF A COMPASS WORD AND A PLACE ("North Texas", "South Florida",
//     "West Midlands", "Greater Manchester"). These are NOT listed, because there is one
//     for every place on the list. PLACE_QUALIFIERS below holds the words that go in
//     front, and the caller reads "a qualifier followed by a place" as a place. That is a
//     rule, so it has no tail of regions nobody thought of.
//   - REGIONS THAT ARE NOT A QUALIFIER AND A PLACE ("North West", "Twin Cities", "North
//     Shore", "Tri-State", "Thames Valley"), the rivers and districts they are named after
//     ("Thames", "Hudson", "Mersey", "Cotswold", "Lakeland"), and the short forms of three
//     letters ("USA", "NYC"). These are listed, under their own heading below. The
//     two-letter short forms ("UK", "US", "EU", "DC", "LA") are not: the short name rule
//     never says a word of under three characters alone, whatever it is.
//   - WORDS THAT ARE NOT PLACES AND FAIL THE SAME WAY. "American Consulting Group" went out
//     as "so American can win the right clients", and "Friday Solutions" as "Friday". The
//     common-word list (common-words.data.ts) holds no capitalised word, so no nationality,
//     weekday or month was on any list. DEMONYMS_AND_CALENDAR_WORDS below holds them, and
//     the caller treats one exactly as it treats a place. The second round of the review
//     found 62 country demonyms still missing, so the country demonyms are now a TABLE
//     keyed by the country list (DEMONYM_OF_COUNTRY), and a test fails on a listed country
//     that has neither a demonym nor a named exception.
//
// NOT ADDED, ON PURPOSE: the invented names this repository's tests use for firms and
// people (Northtown, Kessel, Marlow and the rest). Some of them are also the names of real
// small towns. A list of major places has no reason to hold them, and adding one would
// change what those tests mean.

/**
 * Exported for one test, which pairs every entry here with its demonym (DEMONYM_OF_COUNTRY
 * below) or with a named exception, so a country added here without its adjective fails.
 */
export const COUNTRIES_AND_TERRITORIES: readonly string[] = [
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'antigua', 'antigua and barbuda', 'argentina', 'armenia',
  'australia', 'austria', 'azerbaijan', 'bahamas', 'bahrain', 'bangladesh', 'barbados', 'barbuda', 'belarus', 'belgium',
  'belize', 'benin', 'bhutan', 'bolivia', 'bosnia', 'bosnia and herzegovina', 'botswana', 'brazil', 'brunei', 'bulgaria',
  'burkina faso', 'burma', 'burundi', 'cabo verde', 'cambodia', 'cameroon', 'canada', 'cape verde',
  'central african republic', 'chad', 'chile', 'china', 'colombia', 'comoros', 'congo', 'costa rica', 'croatia', 'cuba',
  'cyprus', 'czech republic', 'czechia', 'denmark', 'djibouti', 'dominica', 'dominican republic', 'east timor', 'ecuador',
  'egypt', 'el salvador', 'equatorial guinea', 'eritrea', 'estonia', 'eswatini', 'ethiopia', 'fiji', 'finland', 'france',
  'gabon', 'gambia', 'georgia', 'germany', 'ghana', 'greece', 'grenada', 'guatemala', 'guinea', 'guinea-bissau', 'guyana',
  'haiti', 'herzegovina', 'holland', 'honduras', 'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq', 'ireland',
  'israel', 'italy', 'ivory coast', 'jamaica', 'japan', 'jordan', 'kazakhstan', 'kenya', 'kiribati', 'korea', 'kosovo',
  'kuwait', 'kyrgyzstan', 'laos', 'latvia', 'lebanon', 'lesotho', 'liberia', 'libya', 'liechtenstein', 'lithuania',
  'luxembourg', 'macedonia', 'madagascar', 'malawi', 'malaysia', 'maldives', 'mali', 'malta', 'marshall islands',
  'mauritania', 'mauritius', 'mexico', 'micronesia', 'moldova', 'monaco', 'mongolia', 'montenegro', 'morocco',
  'mozambique', 'myanmar', 'namibia', 'nauru', 'nepal', 'netherlands', 'new zealand', 'nicaragua', 'niger', 'nigeria',
  'north korea', 'north macedonia', 'norway', 'oman', 'pakistan', 'palau', 'palestine', 'panama', 'papua new guinea',
  'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia', 'rwanda', 'saint kitts and nevis',
  'saint lucia', 'saint vincent and the grenadines', 'samoa', 'san marino', 'sao tome and principe', 'saudi arabia',
  'senegal', 'serbia', 'seychelles', 'sierra leone', 'singapore', 'slovakia', 'slovenia', 'solomon islands', 'somalia',
  'south africa', 'south korea', 'south sudan', 'spain', 'sri lanka', 'sudan', 'suriname', 'swaziland', 'sweden',
  'switzerland', 'syria', 'taiwan', 'tajikistan', 'tanzania', 'thailand', 'timor-leste', 'tobago', 'togo', 'tonga',
  'trinidad', 'trinidad and tobago', 'tunisia', 'turkey', 'turkiye', 'turkmenistan', 'tuvalu', 'uganda', 'ukraine',
  'united arab emirates', 'emirates', 'united kingdom', 'britain', 'great britain', 'united states',
  'united states of america', 'america', 'uruguay', 'uzbekistan', 'vanuatu', 'vatican city', 'venezuela', 'vietnam',
  'yemen', 'zambia', 'zimbabwe',
  // Territories and dependencies a firm is as likely to be named after as a country.
  'aruba', 'bermuda', 'cayman islands', 'curacao', 'faroe islands', 'gibraltar', 'greenland', 'guam', 'guernsey',
  'hong kong', 'isle of man', 'jersey', 'macau', 'puerto rico', 'tahiti', 'virgin islands',
]

const CONTINENTS_AND_REGIONS = [
  'africa', 'americas', 'antarctica', 'asia', 'australasia', 'eurasia', 'europe', 'north america', 'oceania',
  'south america', 'latin america', 'central america', 'middle east', 'far east',
  // Seas and the coasts named after them.
  'adriatic', 'aegean', 'arctic', 'atlantic', 'baltic', 'caribbean', 'mediterranean', 'pacific', 'east coast', 'west coast',
  'gulf coast',
  // Regions that cross borders.
  'alps', 'andes', 'balkans', 'baltics', 'benelux', 'himalayas', 'iberia', 'levant', 'melanesia', 'nordic', 'nordics',
  'patagonia', 'polynesia', 'sahara', 'scandinavia', 'siberia',
  // The short names business uses for a sales region.
  'anz', 'apac', 'dach', 'emea', 'latam', 'mena',
  // Regions inside one country.
  'appalachia', 'bay area', 'cascadia', 'great lakes', 'great plains', 'mid-atlantic', 'midwest', 'new england',
  'northeast', 'northwest', 'ozarks', 'pacific northwest', 'rockies', 'silicon valley', 'southeast', 'southwest',
  'sun belt', 'cotswolds', 'east anglia', 'highlands', 'home counties', 'lake district', 'lowlands', 'midlands',
  'west country', 'andalusia', 'bavaria', 'bengal', 'bohemia', 'borneo', 'brittany', 'catalonia', 'corsica', 'crete',
  'flanders', 'gujarat', 'kashmir', 'kerala', 'lombardy', 'normandy', 'provence', 'punjab', 'sardinia', 'sicily',
  'sumatra', 'transylvania', 'tuscany',
]

/**
 * Added by the review of the fifth reading; see the file header. Regions that are not "a
 * qualifier and a listed place", the rivers and districts regions are named after, and
 * the three-letter short forms.
 */
const REGIONS_RIVERS_AND_SHORT_FORMS = [
  // The compass regions, said as two words or with a hyphen. One word ("northwest") is above.
  'north east', 'north west', 'south east', 'south west', 'north-east', 'north-west', 'south-east', 'south-west',
  // Regions named for what is in them.
  'twin cities', 'tri-state', 'tri-cities', 'quad cities', 'north shore', 'south shore', 'east end', 'west end',
  'inland empire', 'low country', 'hill country', 'gold country', 'black country', 'peak district', 'south downs',
  'thames valley', 'hudson valley', 'central valley', 'lehigh valley', 'shenandoah valley', 'tees valley',
  // Rivers, and districts named after them.
  'thames', 'hudson', 'mersey', 'severn', 'humber', 'clyde', 'tyne', 'tees', 'potomac', 'shenandoah', 'cotswold',
  'lakeland', 'chesapeake bay', 'puget sound',
  // Short forms of three letters. Two letters are held by the three-character floor.
  'usa', 'nyc', 'uae',
]

const UNITED_STATES = [
  // The fifty states, and the district.
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'district of columbia', 'washington dc', 'carolina', 'dakota',
  // The state capitals.
  'montgomery', 'juneau', 'phoenix', 'little rock', 'sacramento', 'denver', 'hartford', 'dover', 'tallahassee',
  'atlanta', 'honolulu', 'boise', 'springfield', 'indianapolis', 'des moines', 'topeka', 'frankfort', 'baton rouge',
  'augusta', 'annapolis', 'boston', 'lansing', 'saint paul', 'st paul', 'jackson', 'jefferson city', 'helena', 'lincoln',
  'carson city', 'concord', 'trenton', 'santa fe', 'albany', 'raleigh', 'bismarck', 'columbus', 'oklahoma city', 'salem',
  'harrisburg', 'providence', 'columbia', 'pierre', 'nashville', 'austin', 'salt lake city', 'montpelier', 'richmond',
  'olympia', 'charleston', 'madison', 'cheyenne',
  // The largest cities, and the smaller ones a firm is often named after.
  'new york city', 'los angeles', 'chicago', 'houston', 'philadelphia', 'san antonio', 'san diego', 'dallas', 'san jose',
  'jacksonville', 'fort worth', 'charlotte', 'san francisco', 'seattle', 'el paso', 'detroit', 'portland', 'memphis',
  'louisville', 'baltimore', 'milwaukee', 'albuquerque', 'tucson', 'fresno', 'mesa', 'kansas city', 'omaha',
  'colorado springs', 'long beach', 'virginia beach', 'miami', 'oakland', 'minneapolis', 'tulsa', 'bakersfield',
  'wichita', 'arlington', 'aurora', 'tampa', 'new orleans', 'cleveland', 'anaheim', 'henderson', 'stockton', 'riverside',
  'lexington', 'corpus christi', 'orlando', 'irvine', 'cincinnati', 'santa ana', 'newark', 'pittsburgh', 'greensboro',
  'st louis', 'saint louis', 'durham', 'plano', 'anchorage', 'jersey city', 'chandler', 'gilbert', 'buffalo', 'reno',
  'scottsdale', 'fort wayne', 'lubbock', 'st petersburg', 'saint petersburg', 'laredo', 'irving', 'chesapeake',
  'glendale', 'winston-salem', 'norfolk', 'garland', 'fremont', 'spokane', 'tacoma', 'modesto', 'huntsville', 'yonkers',
  'rochester', 'birmingham', 'fayetteville', 'san bernardino', 'worcester', 'knoxville', 'chattanooga', 'grand rapids',
  'tempe', 'akron', 'savannah', 'dayton', 'syracuse', 'toledo', 'boulder', 'pasadena', 'santa barbara', 'santa monica',
  'palo alto', 'berkeley', 'sunnyvale', 'mountain view', 'cambridge', 'ann arbor', 'sarasota', 'fort lauderdale',
  'west palm beach', 'boca raton', 'hoboken', 'brooklyn', 'manhattan', 'queens', 'bronx', 'staten island', 'long island',
  'bellevue', 'redmond', 'las vegas', 'new haven', 'stamford', 'greenwich', 'princeton', 'charlottesville', 'asheville',
  'wilmington', 'lancaster', 'allentown', 'scranton', 'erie', 'flint', 'kalamazoo', 'duluth', 'fargo', 'sioux falls',
  'billings', 'missoula', 'bozeman', 'provo', 'ogden', 'santa cruz', 'monterey', 'napa', 'sonoma', 'maui', 'mobile',
  'shreveport', 'lafayette', 'biloxi', 'tuscaloosa', 'pensacola', 'gainesville', 'daytona beach', 'key west', 'macon',
  'greenville', 'spartanburg', 'myrtle beach', 'roanoke', 'alexandria', 'bethesda', 'rockville', 'towson', 'camden',
  'atlantic city', 'burlington', 'bangor', 'manchester', 'nashua', 'lowell', 'bridgeport', 'waterbury', 'peoria',
  'rockford', 'naperville', 'evanston', 'joliet', 'south bend', 'evansville', 'bowling green', 'clarksville',
  'murfreesboro', 'fort smith', 'independence', 'overland park', 'olathe', 'norman', 'amarillo', 'waco', 'mckinney',
  'frisco', 'galveston', 'brownsville', 'mcallen', 'midland', 'odessa', 'las cruces', 'flagstaff', 'yuma', 'sedona',
  'sparks', 'eugene', 'bend', 'medford', 'everett', 'yakima', 'pocatello', 'aspen', 'vail', 'tahoe', 'malibu',
  'hollywood', 'beverly hills', 'cape cod', 'nantucket', 'hamptons', 'chapel hill', 'cary',
]

const CANADA = [
  // Provinces and territories.
  'alberta', 'british columbia', 'manitoba', 'new brunswick', 'newfoundland', 'newfoundland and labrador', 'labrador',
  'nova scotia', 'ontario', 'prince edward island', 'quebec', 'saskatchewan', 'northwest territories', 'nunavut',
  'yukon',
  // Cities.
  'toronto', 'montreal', 'vancouver', 'calgary', 'edmonton', 'ottawa', 'winnipeg', 'quebec city', 'hamilton',
  'kitchener', 'waterloo', 'halifax', 'victoria', 'saskatoon', 'regina', 'st johns', 'kelowna', 'mississauga',
  'brampton', 'burnaby', 'markham', 'oshawa', 'windsor', 'sherbrooke', 'gatineau', 'laval', 'fredericton', 'moncton',
  'charlottetown', 'whitehorse', 'yellowknife', 'iqaluit', 'sudbury', 'thunder bay', 'kingston', 'guelph', 'barrie',
  'niagara', 'niagara falls', 'banff', 'whistler', 'nanaimo', 'lethbridge', 'red deer', 'oakville', 'richmond hill',
]

const UNITED_KINGDOM_AND_IRELAND = [
  // The nations.
  'england', 'scotland', 'wales', 'northern ireland', 'ulster',
  // Counties and the regions spoken of as places.
  'kent', 'essex', 'sussex', 'surrey', 'hampshire', 'devon', 'cornwall', 'dorset', 'somerset', 'norfolk', 'suffolk',
  'yorkshire', 'lancashire', 'cheshire', 'cumbria', 'northumberland', 'lincolnshire', 'derbyshire', 'nottinghamshire',
  'staffordshire', 'shropshire', 'warwickshire', 'worcestershire', 'herefordshire', 'gloucestershire', 'oxfordshire',
  'berkshire', 'buckinghamshire', 'hertfordshire', 'bedfordshire', 'cambridgeshire', 'northamptonshire',
  'leicestershire', 'rutland', 'wiltshire', 'merseyside', 'tyneside', 'middlesex', 'fife', 'lothian', 'ayrshire',
  'aberdeenshire', 'gwent', 'powys', 'antrim',
  // Cities and large towns.
  'london', 'birmingham', 'manchester', 'leeds', 'glasgow', 'liverpool', 'newcastle', 'sheffield', 'bristol',
  'edinburgh', 'cardiff', 'belfast', 'nottingham', 'leicester', 'coventry', 'bradford', 'hull', 'stoke',
  'stoke-on-trent', 'wolverhampton', 'plymouth', 'southampton', 'portsmouth', 'reading', 'derby', 'brighton', 'norwich',
  'swansea', 'aberdeen', 'dundee', 'inverness', 'stirling', 'perth', 'oxford', 'york', 'bath', 'exeter', 'chester',
  'canterbury', 'winchester', 'salisbury', 'carlisle', 'sunderland', 'middlesbrough', 'luton', 'milton keynes',
  'northampton', 'peterborough', 'ipswich', 'colchester', 'chelmsford', 'southend', 'watford', 'slough', 'swindon',
  'cheltenham', 'gloucester', 'hereford', 'shrewsbury', 'telford', 'warrington', 'wigan', 'bolton', 'blackpool',
  'preston', 'blackburn', 'burnley', 'huddersfield', 'wakefield', 'doncaster', 'rotherham', 'barnsley', 'harrogate',
  'scarborough', 'bournemouth', 'poole', 'torquay', 'truro', 'guildford', 'croydon', 'maidstone', 'basingstoke',
  'crawley', 'hastings', 'eastbourne', 'newport', 'wrexham', 'derry', 'londonderry', 'lisburn', 'newry', 'westminster',
  'islington', 'hackney', 'kensington', 'chelsea', 'wimbledon', 'stratford', 'st albans', 'st andrews', 'mayfair',
  'soho', 'shoreditch',
  // Ireland: the provinces, the counties a firm is most often named after, and the towns.
  'munster', 'leinster', 'connacht', 'kerry', 'mayo', 'donegal', 'wicklow', 'meath', 'kildare', 'tipperary', 'dublin',
  'cork', 'limerick', 'galway', 'waterford', 'kilkenny', 'drogheda', 'dundalk', 'sligo', 'athlone', 'wexford', 'tralee',
  'ennis', 'letterkenny', 'killarney',
]

const AUSTRALIA_AND_NEW_ZEALAND = [
  // Australian states and territories.
  'new south wales', 'queensland', 'south australia', 'tasmania', 'western australia', 'northern territory',
  'australian capital territory',
  // Australian cities.
  'sydney', 'melbourne', 'brisbane', 'adelaide', 'canberra', 'hobart', 'darwin', 'gold coast', 'wollongong', 'geelong',
  'cairns', 'townsville', 'toowoomba', 'ballarat', 'bendigo', 'launceston', 'sunshine coast', 'alice springs',
  'fremantle', 'parramatta', 'byron bay', 'mackay', 'rockhampton', 'bunbury', 'albury', 'wagga wagga',
  // New Zealand regions and cities.
  'auckland', 'wellington', 'otago', 'waikato', 'northland', 'taranaki', 'southland', 'hawkes bay', 'bay of plenty',
  'marlborough', 'nelson', 'tasman', 'christchurch', 'tauranga', 'dunedin', 'napier', 'palmerston north', 'rotorua',
  'new plymouth', 'whangarei', 'invercargill', 'queenstown', 'gisborne', 'timaru', 'aotearoa',
]

const EUROPE = [
  'paris', 'marseille', 'lyon', 'toulouse', 'nice', 'nantes', 'strasbourg', 'bordeaux', 'lille', 'cannes', 'berlin',
  'hamburg', 'munich', 'cologne', 'frankfurt', 'stuttgart', 'dusseldorf', 'dortmund', 'essen', 'leipzig', 'dresden',
  'bremen', 'hanover', 'nuremberg', 'bonn', 'heidelberg', 'madrid', 'barcelona', 'valencia', 'seville', 'bilbao',
  'malaga', 'zaragoza', 'granada', 'ibiza', 'mallorca', 'lisbon', 'porto', 'rome', 'milan', 'naples', 'turin',
  'florence', 'venice', 'bologna', 'genoa', 'verona', 'palermo', 'pisa', 'amsterdam', 'rotterdam', 'the hague',
  'utrecht', 'eindhoven', 'brussels', 'antwerp', 'ghent', 'bruges', 'zurich', 'geneva', 'basel', 'bern', 'lausanne',
  'lugano', 'vienna', 'salzburg', 'innsbruck', 'graz', 'copenhagen', 'aarhus', 'stockholm', 'gothenburg', 'malmo',
  'oslo', 'bergen', 'helsinki', 'tampere', 'reykjavik', 'warsaw', 'krakow', 'gdansk', 'wroclaw', 'poznan', 'prague',
  'brno', 'budapest', 'bratislava', 'ljubljana', 'zagreb', 'belgrade', 'sarajevo', 'sofia', 'bucharest', 'athens',
  'thessaloniki', 'istanbul', 'ankara', 'izmir', 'kyiv', 'kiev', 'lviv', 'minsk', 'moscow', 'riga', 'vilnius',
  'tallinn', 'valletta', 'nicosia', 'monte carlo', 'tirana', 'skopje', 'podgorica', 'chisinau', 'tbilisi', 'yerevan',
  'baku',
]

const ASIA_AND_THE_MIDDLE_EAST = [
  'tokyo', 'osaka', 'kyoto', 'yokohama', 'nagoya', 'sapporo', 'fukuoka', 'kobe', 'seoul', 'busan', 'beijing',
  'shanghai', 'shenzhen', 'guangzhou', 'chengdu', 'hangzhou', 'nanjing', 'wuhan', 'tianjin', 'chongqing', 'xian',
  'taipei', 'kaohsiung', 'kuala lumpur', 'penang', 'jakarta', 'surabaya', 'bandung', 'bali', 'bangkok', 'chiang mai',
  'phuket', 'hanoi', 'ho chi minh city', 'saigon', 'manila', 'cebu', 'phnom penh', 'yangon', 'dhaka', 'kathmandu',
  'colombo', 'delhi', 'new delhi', 'mumbai', 'bombay', 'bangalore', 'bengaluru', 'hyderabad', 'chennai', 'madras',
  'kolkata', 'calcutta', 'pune', 'ahmedabad', 'jaipur', 'lucknow', 'surat', 'kochi', 'chandigarh', 'gurgaon', 'noida',
  'goa', 'karachi', 'lahore', 'islamabad', 'kabul', 'tehran', 'baghdad', 'riyadh', 'jeddah', 'mecca', 'dubai',
  'abu dhabi', 'sharjah', 'doha', 'kuwait city', 'manama', 'muscat', 'amman', 'beirut', 'damascus', 'jerusalem',
  'tel aviv', 'haifa', 'tashkent', 'almaty', 'astana', 'ulaanbaatar',
]

const AFRICA_AND_LATIN_AMERICA = [
  'cairo', 'lagos', 'abuja', 'accra', 'nairobi', 'mombasa', 'addis ababa', 'dar es salaam', 'kampala', 'kigali',
  'johannesburg', 'cape town', 'durban', 'pretoria', 'casablanca', 'marrakech', 'rabat', 'tunis', 'algiers', 'tripoli',
  'dakar', 'abidjan', 'kinshasa', 'luanda', 'lusaka', 'harare', 'maputo', 'windhoek', 'gaborone', 'khartoum',
  'mexico city', 'guadalajara', 'monterrey', 'cancun', 'tijuana', 'puebla', 'havana', 'san juan', 'santo domingo',
  'nassau', 'panama city', 'bogota', 'medellin', 'cali', 'cartagena', 'caracas', 'quito', 'guayaquil', 'lima', 'la paz',
  'santiago', 'valparaiso', 'buenos aires', 'cordoba', 'rosario', 'mendoza', 'montevideo', 'asuncion', 'sao paulo',
  'rio de janeiro', 'rio', 'brasilia', 'salvador', 'fortaleza', 'belo horizonte', 'curitiba', 'recife', 'porto alegre',
  'manaus',
]

/**
 * Every listed place, in the form the file header describes. A name that belongs to two
 * sections ("georgia" is a country and a state, "birmingham" a city twice over) is one
 * entry here.
 */
export const PLACE_NAMES: ReadonlySet<string> = new Set([
  ...COUNTRIES_AND_TERRITORIES,
  ...CONTINENTS_AND_REGIONS,
  ...REGIONS_RIVERS_AND_SHORT_FORMS,
  ...UNITED_STATES,
  ...CANADA,
  ...UNITED_KINGDOM_AND_IRELAND,
  ...AUSTRALIA_AND_NEW_ZEALAND,
  ...EUROPE,
  ...ASIA_AND_THE_MIDDLE_EAST,
  ...AFRICA_AND_LATIN_AMERICA,
])


/**
 * THE WORDS THAT MAKE A REGION OUT OF A PLACE. One of these followed by a place is a place:
 * "North Texas", "Southern California", "Central Ohio", "Greater Manchester", "Upper
 * Midwest". The caller applies it as a rule, so no such region has to be listed, and it
 * applies it again to what follows ("North West England"). One word each, lower case.
 */
export const PLACE_QUALIFIERS: ReadonlySet<string> = new Set([
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'northeast', 'northwest',
  'southeast', 'southwest', 'central', 'greater', 'upper', 'lower',
])

/**
 * WHAT A PERSON OR THING FROM EACH LISTED COUNTRY OR TERRITORY IS CALLED. A table keyed by
 * COUNTRIES_AND_TERRITORIES above, written by hand from general knowledge on 2026-10-02, by
 * the second round of the review: the first version was a list, and missed 62 of 197
 * country demonyms ("Dominican", "Costa Rican", "Sri Lankan", "Nepali", "Salvadoran",
 * "Luxembourgish"), each said alone as a firm's name. A test now pairs every listed country
 * with an entry here, or with COUNTRIES_WITHOUT_A_DEMONYM below, so a country added above
 * without its adjective fails.
 *
 * A name that is two names of one country ("burma" and "myanmar") repeats its demonym. A
 * demonym of two words ("costa rican") is matched as a run of words, as a place of two
 * words is.
 */
export const DEMONYM_OF_COUNTRY: Readonly<Record<string, readonly string[]>> = {
  'afghanistan': ['afghan'], 'albania': ['albanian'], 'algeria': ['algerian'], 'andorra': ['andorran'],
  'angola': ['angolan'], 'antigua': ['antiguan'], 'antigua and barbuda': ['antiguan', 'barbudan'],
  'argentina': ['argentine', 'argentinian'], 'armenia': ['armenian'], 'australia': ['australian'],
  'austria': ['austrian'], 'azerbaijan': ['azerbaijani', 'azeri'], 'bahamas': ['bahamian'], 'bahrain': ['bahraini'],
  'bangladesh': ['bangladeshi'], 'barbados': ['barbadian', 'bajan'], 'barbuda': ['barbudan'], 'belarus': ['belarusian'],
  'belgium': ['belgian'], 'belize': ['belizean'], 'benin': ['beninese'], 'bhutan': ['bhutanese'], 'bolivia': ['bolivian'],
  'bosnia': ['bosnian'], 'bosnia and herzegovina': ['bosnian', 'herzegovinian'], 'botswana': ['botswanan', 'motswana', 'batswana'],
  'brazil': ['brazilian'], 'brunei': ['bruneian'], 'bulgaria': ['bulgarian'], 'burkina faso': ['burkinabe'],
  'burma': ['burmese'], 'burundi': ['burundian'], 'cabo verde': ['cabo verdean', 'cape verdean'], 'cambodia': ['cambodian', 'khmer'],
  'cameroon': ['cameroonian'], 'canada': ['canadian'], 'cape verde': ['cape verdean'],
  'central african republic': ['central african'], 'chad': ['chadian'], 'chile': ['chilean'], 'china': ['chinese'],
  'colombia': ['colombian'], 'comoros': ['comoran', 'comorian'], 'congo': ['congolese'], 'costa rica': ['costa rican'],
  'croatia': ['croatian', 'croat'], 'cuba': ['cuban'], 'cyprus': ['cypriot'], 'czech republic': ['czech'], 'czechia': ['czech'],
  'denmark': ['danish', 'dane'], 'djibouti': ['djiboutian'], 'dominica': ['dominican'], 'dominican republic': ['dominican'],
  'east timor': ['timorese'], 'ecuador': ['ecuadorian'], 'egypt': ['egyptian'], 'el salvador': ['salvadoran', 'salvadorian'],
  'equatorial guinea': ['equatoguinean', 'equatorial guinean'], 'eritrea': ['eritrean'], 'estonia': ['estonian'],
  'eswatini': ['swazi'], 'ethiopia': ['ethiopian'], 'fiji': ['fijian'], 'finland': ['finnish', 'finn'], 'france': ['french'],
  'gabon': ['gabonese'], 'gambia': ['gambian'], 'georgia': ['georgian'], 'germany': ['german'], 'ghana': ['ghanaian'],
  'greece': ['greek'], 'grenada': ['grenadian'], 'guatemala': ['guatemalan'], 'guinea': ['guinean'],
  'guinea-bissau': ['bissau-guinean'], 'guyana': ['guyanese'], 'haiti': ['haitian'], 'herzegovina': ['herzegovinian'],
  'holland': ['dutch', 'hollander'], 'honduras': ['honduran'], 'hungary': ['hungarian'], 'iceland': ['icelandic', 'icelander'],
  'india': ['indian'], 'indonesia': ['indonesian'], 'iran': ['iranian'], 'iraq': ['iraqi'], 'ireland': ['irish'],
  'israel': ['israeli'], 'italy': ['italian'], 'ivory coast': ['ivorian'], 'jamaica': ['jamaican'], 'japan': ['japanese'],
  'jordan': ['jordanian'], 'kazakhstan': ['kazakh', 'kazakhstani'], 'kenya': ['kenyan'], 'kiribati': ['i-kiribati'],
  'korea': ['korean'], 'kosovo': ['kosovar', 'kosovan'], 'kuwait': ['kuwaiti'], 'kyrgyzstan': ['kyrgyz'],
  'laos': ['laotian', 'lao'], 'latvia': ['latvian'], 'lebanon': ['lebanese'], 'lesotho': ['basotho', 'mosotho'],
  'liberia': ['liberian'], 'libya': ['libyan'], 'liechtenstein': ['liechtensteiner'], 'lithuania': ['lithuanian'],
  'luxembourg': ['luxembourgish', 'luxembourger'], 'macedonia': ['macedonian'], 'madagascar': ['malagasy'],
  'malawi': ['malawian'], 'malaysia': ['malaysian'], 'maldives': ['maldivian'], 'mali': ['malian'], 'malta': ['maltese'],
  'marshall islands': ['marshallese'], 'mauritania': ['mauritanian'], 'mauritius': ['mauritian'], 'mexico': ['mexican'],
  'micronesia': ['micronesian'], 'moldova': ['moldovan'], 'monaco': ['monegasque', 'monacan'], 'mongolia': ['mongolian'],
  'montenegro': ['montenegrin'], 'morocco': ['moroccan'], 'mozambique': ['mozambican'], 'myanmar': ['burmese'],
  'namibia': ['namibian'], 'nauru': ['nauruan'], 'nepal': ['nepali', 'nepalese'], 'netherlands': ['dutch'],
  'new zealand': ['new zealander'], 'nicaragua': ['nicaraguan'], 'niger': ['nigerien'], 'nigeria': ['nigerian'],
  'north korea': ['north korean'], 'north macedonia': ['macedonian'], 'norway': ['norwegian'], 'oman': ['omani'],
  'pakistan': ['pakistani'], 'palau': ['palauan'], 'palestine': ['palestinian'], 'panama': ['panamanian'],
  'papua new guinea': ['papua new guinean', 'papuan'], 'paraguay': ['paraguayan'], 'peru': ['peruvian'],
  'philippines': ['filipino', 'philippine'], 'poland': ['polish'], 'portugal': ['portuguese'], 'qatar': ['qatari'],
  'romania': ['romanian'], 'russia': ['russian'], 'rwanda': ['rwandan'], 'saint kitts and nevis': ['kittitian', 'nevisian'],
  'saint lucia': ['saint lucian', 'st lucian'], 'saint vincent and the grenadines': ['vincentian'], 'samoa': ['samoan'],
  'san marino': ['sammarinese'], 'sao tome and principe': ['sao tomean', 'santomean'], 'saudi arabia': ['saudi', 'saudi arabian'],
  'senegal': ['senegalese'], 'serbia': ['serbian', 'serb'], 'seychelles': ['seychellois'], 'sierra leone': ['sierra leonean'],
  'singapore': ['singaporean'], 'slovakia': ['slovak', 'slovakian'], 'slovenia': ['slovenian', 'slovene'],
  'solomon islands': ['solomon islander'], 'somalia': ['somali'], 'south africa': ['south african'],
  'south korea': ['south korean'], 'south sudan': ['south sudanese'], 'spain': ['spanish'], 'sri lanka': ['sri lankan'],
  'sudan': ['sudanese'], 'suriname': ['surinamese'], 'swaziland': ['swazi'], 'sweden': ['swedish', 'swede'],
  'switzerland': ['swiss'], 'syria': ['syrian'], 'taiwan': ['taiwanese'], 'tajikistan': ['tajik'], 'tanzania': ['tanzanian'],
  'thailand': ['thai'], 'timor-leste': ['timorese'], 'tobago': ['tobagonian'], 'togo': ['togolese'], 'tonga': ['tongan'],
  'trinidad': ['trinidadian'], 'trinidad and tobago': ['trinidadian', 'tobagonian'], 'tunisia': ['tunisian'],
  'turkey': ['turkish', 'turk'], 'turkiye': ['turkish', 'turk'], 'turkmenistan': ['turkmen'], 'tuvalu': ['tuvaluan'],
  'uganda': ['ugandan'], 'ukraine': ['ukrainian'], 'united arab emirates': ['emirati'], 'emirates': ['emirati'],
  'united kingdom': ['british', 'briton'], 'britain': ['british', 'briton'], 'great britain': ['british', 'briton'],
  'united states': ['american'], 'united states of america': ['american'], 'america': ['american'],
  'uruguay': ['uruguayan'], 'uzbekistan': ['uzbek', 'uzbekistani'], 'vanuatu': ['ni-vanuatu'], 'vatican city': ['vatican'],
  'venezuela': ['venezuelan'], 'vietnam': ['vietnamese'], 'yemen': ['yemeni'], 'zambia': ['zambian'],
  'zimbabwe': ['zimbabwean'],
  // Territories and dependencies.
  'aruba': ['aruban'], 'bermuda': ['bermudian'], 'cayman islands': ['caymanian'], 'curacao': ['curacaoan'],
  'faroe islands': ['faroese'], 'gibraltar': ['gibraltarian'], 'greenland': ['greenlandic', 'greenlander'],
  'guam': ['guamanian'], 'hong kong': ['hongkonger'], 'isle of man': ['manx'], 'macau': ['macanese'],
  'puerto rico': ['puerto rican'], 'tahiti': ['tahitian'], 'virgin islands': ['virgin islander'],
}

/**
 * The listed places with no demonym in ordinary use. A firm says "Jersey" and "Guernsey"
 * of itself, and the islands' own adjectives are not written in English, so there is
 * nothing to list. Each is still a place, so "Jersey Consulting" keeps its full name.
 */
export const COUNTRIES_WITHOUT_A_DEMONYM: ReadonlySet<string> = new Set(['guernsey', 'jersey'])

/**
 * WORDS THAT ARE NOT A FIRM'S NAME SAID ALONE, AND ARE NOT PLACES. Closed sets, the same in
 * every market: what a person or thing from a place is called (the table above, and the
 * lists below), the days of the week and the months. The short name rule treats each
 * exactly as it treats a place, so "American Consulting Group" keeps its full name and
 * "American Ltd" is "your firm".
 *
 * IT LEANS LONG, like the places, and for the same reason: a hit costs nothing. Several of
 * these are also surnames ("French", "English", "Welsh", "German", "Roman"). A firm named
 * after a person called French keeps "French Consulting", which is what it is called.
 *
 * Every listed country now has its demonym. A demonym of a place NOT on the place list, or
 * an adjective for a region nobody listed, still passes as a name. The cost is one odd
 * sentence.
 */
const DEMONYMS = [
  ...Object.values(DEMONYM_OF_COUNTRY).flat(),
  // Peoples, continents, and the nations inside a listed country.
  'african', 'arab', 'arabian', 'arabic', 'asian', 'bengali', 'english', 'european', 'scottish', 'scots', 'welsh',
  // Regions, languages and older peoples a firm styles itself after. The second line was
  // added by the second round of the review: each was said alone as a firm's name.
  'anglo', 'basque', 'bavarian', 'breton', 'cantonese', 'catalan', 'celtic', 'cornish', 'corsican', 'flemish', 'gaelic',
  'germanic', 'hawaiian', 'hebrew', 'hispanic', 'kurdish', 'latin', 'latino', 'latina', 'manx', 'maori', 'norse',
  'persian', 'polynesian', 'prussian', 'roman', 'saxon', 'scandinavian', 'siberian', 'sicilian', 'slavic', 'tibetan',
  'transatlantic', 'zulu',
  'alpine', 'iberian', 'balkan', 'caledonian', 'hibernian', 'midwestern', 'appalachian',
  // States, cities and the names people give themselves.
  'alaskan', 'aussie', 'bostonian', 'cajun', 'californian', 'carolinian', 'cockney', 'creole', 'dixie', 'floridian',
  'geordie', 'glaswegian', 'kiwi', 'liverpudlian', 'londoner', 'mancunian', 'parisian', 'texan', 'venetian',
  'virginian', 'yankee',
]

const WEEKDAYS_AND_MONTHS = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december',
]

export const DEMONYMS_AND_CALENDAR_WORDS: ReadonlySet<string> = new Set([...DEMONYMS, ...WEEKDAYS_AND_MONTHS])
