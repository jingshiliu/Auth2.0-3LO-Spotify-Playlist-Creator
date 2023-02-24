const http = require('http')
const https = require('https')
const fs = require('fs')
const crypto = require('crypto')
const port =  process.env.PORT || 9000

const spotifyCred = require('./credential/spotify-credential.js')

const allSessions = []

const server = http.createServer()
server.listen(port)
server.on('listening', () => {
    console.log(`Listening on port ${port}`)
})



server.on('request', (req, res) => {
    console.log('Received a request for ' + req.url)


    if (req.url === '/') {
        // get userId, assign one if dont have
        getUserIdFromCookie(req, res)
        res.writeHead(200, {'Content-Type': 'text/html'})
        fs.createReadStream('./html/index.html').pipe(res)
    } else if (req.url.startsWith('/create-playlist')) {
        const playlistName = new URL(req.url, `https://${req.headers.host}`).searchParams.get('playlistName')

        if (!playlistName) {
            notFound(res)
            return
        }
        // check cache is access token is valid, bc we dont want to request every time
        // cookieUserId use to uniquely identify client
        // userId=aksjhdajkwhdajkw; expires=12343423412342;
        const cookieUserId = getUserIdFromCookie(req, res)

        let accessTokenCache
        if(fs.existsSync(`./cache/accessToken/${cookieUserId}.json`)){
            accessTokenCache = require(`./cache/accessToken/${cookieUserId}.json`)
            console.log('Access Token cache found')
        }

        if(accessTokenCache && accessTokenCache.expiration > Date.now()){
            console.log('Access Token cache in use')
            sendUserProfileRequest(accessTokenCache.access_token, res, {playlistName}, cookieUserId)
            return
        }

        console.log('Access Token cache not found or expired')
        const state = crypto.randomBytes(20).toString('hex')
        allSessions.push({state, playlistName})
        redirectToSpotify(state, res)


    } else if (req.url.startsWith('/receive-code')) {

        const callbackParams = new URL(req.url, `https://${req.headers.host}`).searchParams
        const authCode = callbackParams.get('code')
        const state = callbackParams.get('state')

        const session = allSessions.find(s => s.state === state)
        if (!session || !state || !authCode) {
            notFound(res)
            return
        }

        const cookieUserId = getUserIdFromCookie(req, res)
        const {playlistName} = session
        sendAccessTokenRequest(authCode, {playlistName}, res, cookieUserId)
    } else {
        notFound(res)
    }
})

function notFound(res) {
    res.writeHead(404, {'Content-Type': 'text/html'})
    res.end('<h1>404</h1><h2>No Found</h2>')
}



function getUserIdFromCookie(req, res){
    try{
        const cookies = req.headers.cookie.split(';').map(c => c.trim().split('='));
        if(Number(cookies.find(e => e[0] === 'expires')[1]) > Date.now() )
            return cookies.find(e => e[0] === 'userId')[1]
        else
            return generateCookie(res)
    }catch (err){
        return generateCookie(res)
    }
}



function generateCookie(res){
    let userId = crypto.randomBytes(20).toString('hex')
    res.setHeader('Set-Cookie', [
        'userId='+userId,
        'expires='+ Date.now() + 3600 * 1000 * 24
    ])
    return userId
}



const redirectURL = `https://spotify-playlist-creater.herokuapp.com/receive-code`
function redirectToSpotify(state, res) {
    const spotifyAuthorizeEndpoint = 'https://accounts.spotify.com/authorize'
    res.writeHead(302, {
        Location: `${spotifyAuthorizeEndpoint}?${
            new URLSearchParams({
                state,
                client_id: spotifyCred.client_id,
                response_type: 'code',
                redirect_uri: redirectURL,
                scope: 'playlist-modify-private playlist-modify-public'
            }).toString()}`
    }).end()
}



function sendAccessTokenRequest(authCode, userInput, res, cookieUserId) {
    const accessTokenEndpoint = 'https://accounts.spotify.com/api/token'
    const postData = new URLSearchParams({
        code: authCode,
        grant_type: 'authorization_code',
        redirect_uri: redirectURL
    }).toString()

    const auth_req = https.request(accessTokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${spotifyCred.client_id}:${spotifyCred.client_secret}`).toString('base64')}`,
            'Content-Length': postData.length
        },
    })

    const sendAuthTime = new Date()

    auth_req.on('error', (err) => console.error(err))

    auth_req.once('response', (stream) => {
        streamToMsg(stream, body => {
            body = JSON.parse(body)
            createAccessTokenCache(body, sendAuthTime, cookieUserId)
            sendUserProfileRequest(body.access_token, res, userInput, cookieUserId)
        })
    })
    auth_req.end(postData)
}



function createAccessTokenCache(spotify_auth, authSentTime, cookieUserId) {
    spotify_auth.expiration  = authSentTime.getTime() + 3600 * 1000

    fs.writeFile(`./cache/accessToken/${cookieUserId}.json`, JSON.stringify(spotify_auth), err =>{
        if(err) throw err;
        console.log('Success write')
    })
}



function createSpotifyIDCache(spotifyID, spotifyIDSendTime, cookieUserId) {
    // if user changes spotify ID within 24 hours, the one stored in cached will be invalid and might lead to bad result
    spotifyID.expiration  = spotifyIDSendTime.getTime() + 3600 * 1000 * 24 // expire in 24 hours

    fs.writeFile(`./cache/spotifyID/${cookieUserId}.json`, JSON.stringify(spotifyID), err =>{
        if(err) throw err;
        console.log('Success write')
    })
}



function sendAnimeQuoteRequest(accessToken, spotifyID, res, userInput) {
    const animeQuoteEndpoint = 'https://animechan.vercel.app/api/random'
    https.get(animeQuoteEndpoint, animeQuoteRes => {
        let body = ''
        animeQuoteRes.on('data', data => body += data)

        animeQuoteRes.on('end', () => {
            sendCreatePlaylistRequest(accessToken, spotifyID , res, JSON.parse(body), userInput)
        })
    }).on('error', err => console.error(err))
}



function sendUserProfileRequest(accessToken, res, userInput, cookieUserId){

    let spotifyIDCache
    if(fs.existsSync(`./cache/spotifyID/${cookieUserId}.json`)){
        spotifyIDCache = require(`./cache/spotifyID/${cookieUserId}.json`)
        console.log('Spotify ID cache found')
    }

    if(spotifyIDCache && spotifyIDCache.expiration > Date.now()){
        console.log('Spotify ID cache in use')
        sendAnimeQuoteRequest(accessToken, spotifyIDCache.id, res, userInput)
        return
    }

    console.log('Spotify ID cache not found or expired')
    https.get({
        hostname: 'api.spotify.com',
        path: '/v1/me',
        headers:{
            'Authorization': 'Bearer ' + accessToken
        }
    }, spotifyUserRes =>{
        let body = ''
        let userProfileSendTime = new Date()
        spotifyUserRes.on('data', data => body += data)
        spotifyUserRes.on('end', ()=>{
            body = JSON.parse(body)
            createSpotifyIDCache({id: body.id}, userProfileSendTime, cookieUserId)
            sendAnimeQuoteRequest(accessToken, body.id, res, userInput)
        })
    })
}



function sendCreatePlaylistRequest(accessToken, spotifyID , res, animeData, userInput) {
    try{
        const spotifyPlaylistEndpoint = `https://api.spotify.com/v1/users/${spotifyID}/playlists`

        const postData = JSON.stringify({
            name: `${animeData.character} - ${userInput.playlistName}`,
            description: '',
        })

        const playlistReq = https.request(spotifyPlaylistEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + accessToken,
                'Content-Length': postData.length
            },
        })

        playlistReq.on('error', (err) => console.error(err))

        playlistReq.once('response', (stream) => {
            streamToMsg(stream, body => {
                body = JSON.parse(body)
                res.writeHead(302, {Location: body.external_urls.spotify}).end()
            })
        })
        playlistReq.write(postData)
        playlistReq.end()
    }catch (err){
        console.log(err)
    }
}



function streamToMsg(stream, callback) {
    let body = ''
    stream.on('data', chunk => body += chunk)
    stream.on('end', () => callback(body))
}
