/********************************************************************************
 * Copyright (c) 2018 - 2019 Contributors to the Eclipse Foundation
 * 
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 * 
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0, or the W3C Software Notice and
 * Document License (2015-05-13) which is available at
 * https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document.
 * 
 * SPDX-License-Identifier: EPL-2.0 OR W3C-20150513
 ********************************************************************************/

/**
 * HTTP client based on http
 */

import * as http from "http";
import * as https from "https";

import { Subscription } from "rxjs/Subscription";

import * as TD from "@node-wot/td-tools";
// for Security definition
import * as WoT from "wot-typescript-definitions";

import { ProtocolClient, Content } from "@node-wot/core";
import { HttpForm, HttpHeader, HttpConfig, HTTPMethodName } from "./http";
import fetch, { Request,RequestInit,Response } from 'node-fetch';
import { Buffer } from "buffer";
import OAuthManager from "./oauth-manager";
import { parse } from "url";
import { BasicCredential, Credential, BearerCredential, BasicKeyCredential, OAuthCredential } from "./credential";

export default class HttpClient implements ProtocolClient {

  private readonly agent: http.Agent;
  private readonly provider: any;
  private proxyRequest: Request = null;
  private authorization: string = null;
  private authorizationHeader: string = "Authorization";
  private allowSelfSigned: boolean = false;
  private oauth: OAuthManager;

  private credential:Credential = null;

  constructor(config: HttpConfig = null, secure = false,oauthManager: OAuthManager = new OAuthManager()) {

    // config proxy by client side (not from TD)
    if (config!==null && config.proxy && config.proxy.href) {
      this.proxyRequest = new Request(HttpClient.fixLocalhostName(config.proxy.href))
      
      if (config.proxy.scheme === "basic") {
        if (!config.proxy.hasOwnProperty("username") || !config.proxy.hasOwnProperty("password")) console.warn(`HttpClient client configured for basic proxy auth, but no username/password given`);
        this.proxyRequest.headers.set('proxy-authorization', "Basic " + Buffer.from(config.proxy.username + ":" + config.proxy.password).toString('base64'));
      } else if (config.proxy.scheme === "bearer") {
        if (!config.proxy.hasOwnProperty("token")) console.warn(`HttpClient client configured for bearer proxy auth, but no token given`);
        this.proxyRequest.headers.set('proxy-authorization', "Bearer " + config.proxy.token);
      }
      // security for hop to proxy
      if (this.proxyRequest.protocol === "https") {
        secure = true;
      }
      
      console.info(`HttpClient using ${secure ? "secure " : ""}proxy ${this.proxyRequest.hostname}:${this.proxyRequest.port}`);
    }

    // config certificate checks
    if (config!==null && config.allowSelfSigned!==undefined) {
      this.allowSelfSigned = config.allowSelfSigned;
      console.warn(`HttpClient allowing self-signed/untrusted certificates -- USE FOR TESTING ONLY`);
    }

    // using one client impl for both HTTP and HTTPS
    this.agent = secure ? new https.Agent({
      rejectUnauthorized : !this.allowSelfSigned
    }) : new http.Agent();

    this.provider = secure ? https : http;
    this.oauth = oauthManager;
  }

  public toString(): string {
    return `[HttpClient]`;
  }

  public async readResource(form: HttpForm): Promise<Content> {
    const request = this.generateFetchRequest(form, "GET")
    console.info(`HttpClient (readResource) sending ${request.method} to ${request.url}`);

    const result = await fetch(request)
    
    this.checkFetchResponse(result)
    
    const buffer = await result.buffer()
    
    console.debug(`HttpClient received headers: ${JSON.stringify(result.headers.raw())}`);
    console.debug(`HttpClient received Content-Type: ${result.headers.get("content-type")}`);
    
    return { type: result.headers.get("content-type"), body: buffer };
  }

  public async writeResource(form: HttpForm, content: Content): Promise<any> {
    const request = this.generateFetchRequest(form, "PUT",{
      headers : [["content-type",content.type]],
      body: content.body
    })

    console.log(`HttpClient (writeResource) sending ${request.method} with '${request.headers.get("Content-Type")}' to ${request.url}`);
    
    const result = await fetch(request)
    console.info(`HttpClient received ${result.status} from ${result.url}`);
    
    this.checkFetchResponse(result)
    
    console.log(`HttpClient received headers: ${JSON.stringify(result.headers.raw())}`);
    return;
  }

  public async invokeResource(form: HttpForm, content?: Content): Promise<Content> {
    const headers = content ? [["content-type", content.type]] : []

    const request = this.generateFetchRequest(form, "POST",{
      headers : headers,
      body : content?.body
    })

    console.info(`HttpClient (invokeResource) sending ${request.method} ${content ? "with '" + request.headers.get("Content-Type") + "' " : " "}to ${request.url}`);

    const result = await fetch(request, { body: content?.body })

    console.info(`HttpClient received ${result.status} from ${request.url}`);
    console.debug(`HttpClient received Content-Type: ${result.headers.get("content-type")}`);
    
    const buffer = await result.buffer()

    return { type: result.headers.get("content-type"), body: buffer };
  }

  public async unlinkResource(form: HttpForm): Promise<any> {
    const request = this.generateFetchRequest(form, "DELETE")
    console.info(`HttpClient (unlinkResource) sending ${request.method} to ${request.url}`);

    const result = await fetch(request)

    // TODO might have response on unlink for future HATEOAS concept
    this.checkFetchResponse(result)

    const buffer = await result.buffer()
    
    console.debug(`HttpClient received headers: ${JSON.stringify(result.headers.raw())}`);
    console.debug(`HttpClient received Content-Type: ${result.headers.get("content-type")}`);

    return { type: result.headers.get("content-type"), body: buffer };
  }

  public subscribeResource(form: HttpForm, next: ((value: any) => void), error?: (error: any) => void, complete?: () => void): any {

    let active = true;
    let polling = async () => {
      try {
        // long timeout for long polling
        const request = this.generateFetchRequest(form, "GET", { timeout: 60 * 60 * 1000 })
        console.info(`HttpClient (subscribeResource) sending ${request.method} to ${request.url}`);

        const result = await fetch(request)

        this.checkFetchResponse(result)

        const buffer = await result.buffer()
        console.info(`HttpClient received ${result.status} from ${request.url}`);

        console.debug(`HttpClient received headers: ${JSON.stringify(result.headers.raw())}`);
        console.debug(`HttpClient received Content-Type: ${result.headers.get("content-type")}`);

        if (active) {
          next({ type: result.headers.get("content-type"), body: buffer })
          polling()
        }
      } catch (e) {
        error && error(e)
        complete && complete()
        active = false
      }
    }

    polling();

    return new Subscription( () => { active = false; } );
  }

  public start(): boolean {
    return true;
  }

  public stop(): boolean {
    if (this.agent && this.agent.destroy) this.agent.destroy();  // When running in browser mode, Agent.destroy() might not exist.
    return true;
  }

  public async initSecurity(metadata: Array<TD.SecurityScheme>, credentials?: any): Promise<boolean> {

    if (metadata === undefined || !Array.isArray(metadata) || metadata.length == 0) {
      console.warn(`HttpClient without security`);
      return false;
    }

    // TODO support for multiple security schemes
    let security: TD.SecurityScheme = metadata[0];
    switch (security.scheme) {
      case "basic":
        this.credential = new BasicCredential(credentials)
        break;
      case "bearer":
      // TODO check security.in and adjust
        this.credential = new BearerCredential(credentials?.token)
        break;
      case "apikey":
        let securityAPIKey: TD.APIKeySecurityScheme = <TD.APIKeySecurityScheme>security;

        this.credential = new BasicKeyCredential(credentials?.apiKey, securityAPIKey)
        break;
      case "oauth2":
      let securityOAuth: TD.OAuth2SecurityScheme = <TD.OAuth2SecurityScheme>security;
      
        if (securityOAuth.flow === "client_credentials") {
          this.credential = await this.oauth.handleClientCredential(securityOAuth, credentials)
        } else if (securityOAuth.flow === "password") {
          this.credential = await this.oauth.handleResourceOwnerCredential(securityOAuth, credentials)
      }

        break;
      case "nosec":
        break;
      default:
      console.error(`HttpClient cannot set security scheme '${security.scheme}'`);
      console.dir(metadata);
      return false;
    }

    if (security.proxy) {
      if (this.proxyRequest !== null) {
        console.info(`HttpClient overriding client-side proxy with security proxy '${security.proxy}`);
      }

      this.proxyRequest = new Request(HttpClient.fixLocalhostName(security.proxy))

      // TODO support for different credentials at proxy and server (e.g., credentials.username vs credentials.proxy.username)
      if (security.scheme == "basic") {
        if (credentials === undefined || credentials.username === undefined || credentials.password === undefined) {
          throw new Error(`No Basic credentionals for Thing`);
        }
        this.proxyRequest.headers.set('proxy-authorization', "Basic " + Buffer.from(credentials.username + ":" + credentials.password).toString('base64'));
      } else if (security.scheme == "bearer") {
        if (credentials === undefined || credentials.token === undefined) {
          throw new Error(`No Bearer credentionals for Thing`);
        }
        this.proxyRequest.headers.set('proxy-authorization', "Bearer " + credentials.token);
      }
    }

    console.log(`HttpClient using security scheme '${security.scheme}'`);
    return true;
  }

  private generateFetchRequest(form: HttpForm, defaultMethod: HTTPMethodName, additionalOptions: RequestInit={}){
    let requestInit : RequestInit = additionalOptions
   
    let url = HttpClient.fixLocalhostName(form.href)

    requestInit.method = form["htv:methodName"] ? form["htv:methodName"] : defaultMethod;
    
    requestInit.headers = requestInit.headers ?? []
    requestInit.headers = requestInit.headers as string[][]
    
    if (Array.isArray(form["htv:headers"])) {
      console.debug("HttpClient got Form 'headers'", form["htv:headers"]);
      
      let headers = form["htv:headers"] as Array<HttpHeader>;
      for (let option of headers) {
        requestInit.headers.push([option["htv:fieldName"], option["htv:fieldValue"]]);
      }
    } else if (typeof form["htv:headers"] === "object") {
      console.debug("HttpClient got Form SINGLE-ENTRY 'headers'", form["htv:headers"]);
      
      let option = form["htv:headers"] as HttpHeader;
      requestInit.headers.push([option["htv:fieldName"], option["htv:fieldValue"]]);
    }

    
    
    requestInit.agent = this.agent

    let request = this.proxyRequest ? new Request(this.proxyRequest, requestInit) : new Request(url, requestInit);
    
    // Sign the request using client credentials
    if (this.credential) {
      request = this.credential.sign(request)
    }

    if(this.proxyRequest){
      const parsedBaseURL = parse(url)
      request.url = request.url + parsedBaseURL.path
      
      console.debug("HttpClient proxy request URL:",request.url)

      request.headers.set("host", parsedBaseURL.hostname)
    }

    return  request;
  }

  private checkFetchResponse(response:Response){
    const statusCode = response.status

    if (statusCode < 200) {
      throw new Error(`HttpClient received ${statusCode} and cannot continue (not implemented, open GitHub Issue)`);
    }else if (statusCode < 300) {
        return // No error
    } else if (statusCode < 400) {
      throw new Error(`HttpClient received ${statusCode} and cannot continue (not implemented, open GitHub Issue)`);
    } else if (statusCode < 500) {
      throw new Error(`Client error: ${response.statusText}`);
    } else {
      throw new Error(`Server error: ${response.statusText}`);
    }
  }

  private static fixLocalhostName(url:string) {
    const localhostPresent = /^(https?:)?(\/\/)?(?:[^@\n]+@)?(www\.)?(localhost)/gm
    
    if (localhostPresent.test(url)) {
      console.warn("LOCALHOST FIX");
      return url.replace(localhostPresent, "$1$2127.0.0.1")
    }
    
    return url
  }
}
