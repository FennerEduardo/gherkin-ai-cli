package users

import "github.com/gin-gonic/gin"

func UsersRegister(router *gin.RouterGroup) {
	router.POST("", UsersRegistration)
	router.POST("/", UsersRegistration)
	router.POST("/login", UsersLogin)
}

func UsersRegistration(c *gin.Context) { c.JSON(201, gin.H{}) }

func UsersLogin(c *gin.Context) { c.JSON(200, gin.H{}) }
